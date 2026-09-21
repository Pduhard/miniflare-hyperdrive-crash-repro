import { Miniflare } from "miniflare";
import { startFakePostgres } from "./fake-postgres.mjs";

const sslmode = process.env.SSLMODE ?? "require";
const { port } = await startFakePostgres({ tlsEnabled: sslmode !== "disable" });

const workerThatHalfClosesMidStream = `
  import { connect } from "cloudflare:sockets";

  export default {
    async fetch(request, env) {
      const socket = connect({ hostname: env.DB.host, port: env.DB.port });
      const writer = socket.writable.getWriter();
      await writer.write(new Uint8Array([0]));
      socket.readable.pipeTo(new WritableStream({ write() {} })).catch(() => {});
      await scheduler.wait(100);
      await writer.close().catch(() => {});
      return new Response("half-closed");
    },
  };
`;

const mf = new Miniflare({
  modules: true,
  compatibilityDate: "2026-04-01",
  hyperdrives: { DB: `postgres://user:password@127.0.0.1:${port}/db?sslmode=${sslmode}` },
  script: workerThatHalfClosesMidStream,
});

console.log(`sslmode=${sslmode}`);

for (let attempt = 0; attempt < 20; attempt++) {
  await mf.dispatchFetch("http://example.com/").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(`attempt ${attempt + 1} survived`);
}

await mf.dispose();
console.log("survived — no crash");
process.exit(0);
