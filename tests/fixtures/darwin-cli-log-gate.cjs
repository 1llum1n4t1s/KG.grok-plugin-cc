const fs = require("node:fs");
const originalWrite = fs.writeFileSync;
const ready = process.env.GROK_TEST_LOG_READY;
const mode = process.env.GROK_TEST_LOG_MODE;
let triggered = false;
fs.writeFileSync = function (file, data, options) {
  if (!triggered && typeof file === "string" && file.endsWith(".log") && options?.flag === "wx") {
    triggered = true;
    if (mode === "collision") originalWrite.call(this, file, "existing log preserved\n", { flag: "wx", mode: 0o600 });
    originalWrite.call(this, ready, JSON.stringify({ file }), "utf8");
    if (mode === "eio") {
      const error = new Error("test log creation EIO");
      error.code = "EIO";
      throw error;
    }
    const value = originalWrite.call(this, file, data, options);
    if (mode === "pause") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    return value;
  }
  return originalWrite.call(this, file, data, options);
};
