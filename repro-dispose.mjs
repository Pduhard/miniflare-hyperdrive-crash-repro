import { Miniflare } from "miniflare";
import { startFakePostgres } from "./fake-postgres.mjs";

const sslmode = process.env.SSLMODE ?? "require";
const { port } = await startFakePostgres({ tlsEnabled: sslmode !== "disable" });

const workerThatLeavesConnectionsOpen = `
  import { connect } from "cloudflare:sockets";

  export default {
    async fetch(request, env) {
      const socket = connect({ hostname: env.DB.host, port: env.DB.port });
      const writer = socket.writable.getWriter();
      await writer.write(new Uint8Array([0]));
      writer.releaseLock();
      socket.readable.pipeTo(new WritableStream({ write() {} })).catch(() => {});
      return new Response("open");
    },
  };
`;

console.log(`sslmode=${sslmode}`);

for (let round = 0; round < 12; round++) {
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: "2026-04-01",
    hyperdrives: { DB: `postgres://user:password@127.0.0.1:${port}/db?sslmode=${sslmode}` },
    script: workerThatLeavesConnectionsOpen,
  });

  await Promise.all(
    Array.from({ length: 16 }, () => mf.dispatchFetch("http://example.com/").catch(() => {})),
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  await mf.dispose();
  console.log(`round ${round + 1} survived`);
}

console.log("survived — no crash");
process.exit(0);
