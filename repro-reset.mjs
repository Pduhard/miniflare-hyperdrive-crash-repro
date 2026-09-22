import net from "node:net";

// Miniflare does not expose the port its Hyperdrive proxy listens on, and the
// binding's host only resolves inside workerd, so we note the port as it is
// bound. The proxy is the only raw net.Server Miniflare opens.
const proxyPorts = [];
const createServer = net.createServer;
net.createServer = (...args) => {
  const server = createServer(...args);
  server.once("listening", () => proxyPorts.push(server.address().port));
  return server;
};

const { Miniflare } = await import("miniflare");

// A Postgres that sits on the SSLRequest for 400ms, leaving a window in which
// the proxy is still negotiating while the client goes away.
const db = createServer((socket) => {
  socket.on("error", () => {});
  socket.once("data", () => setTimeout(() => socket.write(Buffer.from("N")), 400));
});
const dbPort = await new Promise((resolve) =>
  db.listen(0, "127.0.0.1", () => resolve(db.address().port))
);

const mf = new Miniflare({
  modules: true,
  compatibilityDate: "2026-04-01",
  hyperdrives: { DB: `postgres://user:password@127.0.0.1:${dbPort}/db?sslmode=require` },
  script: `export default { fetch: () => new Response("ok") };`,
});
await mf.ready;

const [proxyPort] = proxyPorts;
console.log(`hyperdrive proxy on 127.0.0.1:${proxyPort}`);

for (let attempt = 0; attempt < 5; attempt++) {
  await new Promise((resolve) => {
    const client = net.connect({ host: "127.0.0.1", port: proxyPort }, () => {
      client.write(Buffer.from([0]));
      setTimeout(() => {
        client.resetAndDestroy();
        resolve();
      }, 50);
    });
    client.on("error", () => {});
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  console.log(`attempt ${attempt + 1} survived`);
}

await mf.dispose();
console.log("survived — no crash");
process.exit(0);
