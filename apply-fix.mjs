import { readFileSync, writeFileSync } from "node:fs";

const path = "node_modules/miniflare/dist/src/index.js";
const source = readFileSync(path, "utf8");

const anchor = `    const dbSocket = import_node_net.default.connect({ host: targetHost, port: targetPort });
`;
const handlers = `    clientSocket.on("error", () => dbSocket.destroy());
    dbSocket.on("error", () => clientSocket.destroy());
`;

const reverting = process.argv.includes("--revert");

if (reverting) {
  if (!source.includes(handlers)) {
    console.log("nothing to revert");
    process.exit(0);
  }
  writeFileSync(path, source.replace(anchor + handlers, anchor));
  console.log("reverted");
  process.exit(0);
}

if (source.includes(handlers)) {
  console.log("already applied");
  process.exit(0);
}

if (!source.includes(anchor)) {
  throw new Error(`anchor not found in ${path}`);
}

writeFileSync(path, source.replace(anchor, anchor + handlers));
console.log("applied");
