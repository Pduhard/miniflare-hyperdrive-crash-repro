import { PassThrough } from "node:stream";

const withExtraListener = process.argv.includes("--with-listener");

const source = new PassThrough();
const destination = new PassThrough();

source.pipe(destination);

console.log("error listeners on destination after pipe():", destination.listenerCount("error"));

if (withExtraListener) {
  destination.on("error", () => console.log("our own listener caught it"));
  console.log("error listeners after adding ours:", destination.listenerCount("error"));
}

destination.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

setTimeout(() => console.log("process survived"), 100);
