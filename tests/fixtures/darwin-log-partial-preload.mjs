import fs from "node:fs";

const target = process.env.GROK_TEST_PARTIAL_LOG;
const originalOpen = fs.openSync.bind(fs), originalClose = fs.closeSync.bind(fs), originalWrite = fs.writeFileSync.bind(fs);
const watched = new Set();
fs.openSync = (name, ...args) => {
  const fd = originalOpen(name, ...args);
  if (String(name) === target) watched.add(fd);
  return fd;
};
fs.closeSync = fd => { watched.delete(fd); return originalClose(fd); };
fs.writeFileSync = (file, contents, ...args) => {
  if (typeof file === "number" && watched.has(file) && String(contents).includes("Final output")) {
    const bytes = Buffer.from(String(contents));
    fs.writeSync(file, bytes, 0, Math.min(12, bytes.length));
    throw Object.assign(new Error("injected partial log write"), { code: "EIO" });
  }
  return originalWrite(file, contents, ...args);
};
