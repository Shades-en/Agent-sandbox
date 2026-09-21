// Start Node once during snapshot preparation. Register the input handlers
// before announcing readiness, so the snapshot contains a waiting runtime.
const { Script } = require("node:vm");
const { createRequire } = require("node:module");
const { randomBytes } = require("node:crypto");
// V8 also snapshots its Math.random cache. Use the reseeded Node RNG so
// independent restored executions do not repeat that saved sequence.
Math.random = () => Number(randomBytes(8).readBigUInt64BE() >> 11n) / 2 ** 53;
const reseed = process.env.SANDBOX_RESEED_MODULE ? require(process.env.SANDBOX_RESEED_MODULE) : null;
delete process.env.SANDBOX_RESEED_MODULE;

// Code runs as a regular script with Node globals and CommonJS require().
// Firecracker provides isolation; node:vm is only how we execute the source.
globalThis.require = createRequire("/sandbox.js");
globalThis.__filename = "/sandbox.js";
globalThis.__dirname = "/";

// Warm the script execution path before saving the snapshot.
new Script("void 0").runInThisContext();
process.stderr.write("");
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { source += chunk; });
process.stdin.on("end", () => {
  // Python closes stdin after writing one complete program. Timers and
  // promises still run normally; Node exits when its event loop is finished.
  const request = JSON.parse(source);
  // A snapshot also clones OpenSSL state. Reseed before TLS or user code.
  if (reseed) reseed.reseed(Buffer.from(request.entropy, "hex"));
  new Script(request.code, { filename: "/sandbox.js" }).runInThisContext();
});

// Python consumes this line before accepting any user code. Using console.log
// here also initializes the console, so the first tool call need not do it.
console.log("SANDBOX_NODE_READY");
