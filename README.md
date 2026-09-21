# A Hyperdrive proxy socket error takes down the whole Node process

In Miniflare's local Hyperdrive emulation, the socket that carries workerd's side of a
connection never gets an `'error'` handler on any code path. When it errors — the Worker
hangs up mid-stream, the database resets the connection — Node emits an unhandled
`'error'` event and the host process dies: `wrangler dev`, `getPlatformProxy()`, or a
whole `vitest` run, killed by one socket.

This is not a bug in Hyperdrive the product. Only local emulation is affected.

## Reproducing

```
npm install
npm run repro:half-close
```

Expected, on `miniflare@4.20260730.0`:

```
node:events:496
      throw er; // Unhandled 'error' event
Error: This socket has been ended by the other party
    at Socket.writeAfterFIN [as write] (node:net:793:14)
    at Socket.ondata (node:internal/streams/readable:1020:24)
  code: 'EPIPE'
```

Whether the write lands just before or just after the peer's FIN decides which of the
two EPIPE forms you get; `Error: write EPIPE` is the same failure.

The script stands up a TCP server that speaks just enough of the Postgres protocol to
negotiate TLS, then streams rows. A Worker connects through the Hyperdrive binding and
half-closes its socket while those rows are still arriving. Nothing reaches into
Miniflare's internals.

`npm run fix` applies the patch below to the installed `miniflare` and `npm run unfix`
reverts it, so both sides are checkable in one command.

## Where it comes from

`packages/miniflare/src/plugins/hyperdrive/hyperdrive-proxy.ts` ends every path by
piping the two sockets together:

```ts
clientSocket.pipe(dbSocket);
dbSocket.pipe(clientSocket);
```

The file does handle socket errors — but only ever on the database side:

- `createPlainTCPConnection` → `dbSocket.on("error", () => clientSocket.destroy())`
- `setupTLSConnection` → `tlsSocket.on("error", () => { ... })`

`clientSocket` gets nothing, on any of the four paths that reach a pipe. That asymmetry
looks like an oversight rather than a decision: the same function guards one end and not
the other.

`Readable.pipe()` is not a safety net here. It does attach an `'error'` listener to the
destination, but that listener removes itself and re-emits when no other listener
remains, so the error still reaches the process unhandled.
`node why-pipe-does-not-protect-you.mjs` shows this in nine lines, with no Miniflare
involved; pass `--with-listener` to see one extra listener change the outcome.

`dispose()` makes teardown a reliable way in. It closes the proxy servers but
deliberately does not wait for open sockets, and its own comment acknowledges they
linger.

## The fix

Two lines at the top of `#handleConnection`, before any branch:

```ts
clientSocket.on("error", () => dbSocket.destroy());
dbSocket.on("error", () => clientSocket.destroy());
```

Routing them through the controller's `log` first would be friendlier still: today a
database that resets a connection gives the user a bare Node stack trace that never
mentions Hyperdrive.

## Which versions are affected

| Version | `sslmode=disable` | `sslmode=require` |
| --- | --- | --- |
| `4.20260424.0` | `EPIPE`, crashes | `EPIPE`, crashes |
| `4.20260730.0` | survives | **`EPIPE`, crashes** |
| `4.20260730.0` + the fix | survives | survives |

`sslmode=disable` stopped crashing because of a change in `index.ts`, not a fix to the
proxy:

```ts
if (sslmode === "disable") {
  // connect directly to the database without a proxy server
  address = `${url.hostname}:${targetPort}`;
} else {
  const proxyPort = await hyperdriveProxyController.createProxyServer({ ... });
  address = `127.0.0.1:${proxyPort}`;
}
```

With `sslmode=disable` there is no longer a proxy to crash. Every other mode —
`require`, `prefer`, `verify-ca`, `verify-full` — still goes through it, which is to say
every hosted Postgres that insists on TLS: Neon, Supabase, RDS.

Run the disable case yourself with `SSLMODE=disable npm run repro:half-close`.

`repro-dispose.mjs` is a second scenario: Workers that leave a pooled connection open,
then `dispose()`. It crashes on `4.20260424.0` with
`Error: This socket has been ended by the other party` — the failure that led here, seen
in CI on `@cloudflare/vitest-pool-workers`. It no longer crashes on `4.20260730.0`,
for the `sslmode=disable` reason above.

`5.20260921.0-alpha` carries the same `hyperdrive-proxy.ts`, but its constructor options
were restructured, so these scripts do not run against it unchanged.

Reproduced on Linux 7.0.0, Node v22.14.0.
