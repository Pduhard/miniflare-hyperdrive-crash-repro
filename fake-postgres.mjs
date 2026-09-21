import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

const keyPath = new URL("./key.pem", import.meta.url);
const certPath = new URL("./cert.pem", import.meta.url);

if (!existsSync(keyPath) || !existsSync(certPath)) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath.pathname, "-out", certPath.pathname,
    "-days", "3650", "-subj", "/CN=localhost",
  ]);
}

const key = readFileSync(keyPath);
const cert = readFileSync(certPath);

export function startFakePostgres({ tlsEnabled }) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});

    if (!tlsEnabled) {
      startPumping(socket);
      return;
    }

    socket.once("data", () => {
      socket.write(Buffer.from("S"));
      const secured = new tls.TLSSocket(socket, { isServer: true, key, cert });
      secured.on("error", () => {});
      secured.on("secure", () => startPumping(secured));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function startPumping(stream) {
  const pump = setInterval(() => stream.write(Buffer.alloc(256 * 1024)), 1);
  const stopPumping = () => clearInterval(pump);
  stream.on("close", stopPumping);
  stream.on("error", stopPumping);
}
