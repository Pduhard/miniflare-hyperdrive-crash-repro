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
      ^

Error: write EPIPE
    at WriteWrap.onWriteComplete [as oncomplete] (node:internal/stream_base_commons:87:19)
Emitted 'error' event on Socket instance at:
    at Socket.onerror (node:internal/streams/readable:1028:14)
    at Socket.emit (node:events:518:28)
  errno: -32,
  code: 'EPIPE',
  syscall: 'write'
```

`Socket.onerror` is the listener `pipe()` installs on the destination, re-emitting
because nothing else is listening. Whether the write lands just before or just after the
peer's FIN decides the exact form: `Error: This socket has been ended by the other party`
at `Socket.writeAfterFIN` is the same failure.

The script stands up a TCP server that speaks just enough of the Postgres protocol to
negotiate TLS, then streams rows. A Worker connects through the Hyperdrive binding and
half-closes its socket while those rows are still arriving. Nothing reaches into
Miniflare's internals.

`npm run fix` applies the patch below to the installed `miniflare` and `npm run unfix`
reverts it, so both sides are checkable in one command.

Every row of the table below was run on Node v22.14.0 on 2026-09-22.

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

`npm run fix` applies exactly that and the crash goes away, which is enough to show the
missing listener is the cause.

A complete fix has to go a little further. The handlers that already exist tear down the
*other* side of the pipe, and on the TLS paths the socket that ends up piped is not the
`dbSocket` created at the top of `#handleConnection` but a later `newDbSocket` or
`tlsSocket`. So the listener belongs at each of the four pipe sites, where the peer
socket is in scope, rather than once at the entry.

Routing the error through the controller's `log` would be friendlier still: today a
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

`5.20260921.0-alpha` carries the same `hyperdrive-proxy.ts`, but its constructor options
were restructured, so these scripts do not run against it unchanged.

Reproduced on Linux 7.0.0, Node v22.14.0.
