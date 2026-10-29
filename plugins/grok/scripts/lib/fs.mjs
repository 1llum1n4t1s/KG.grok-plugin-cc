import fs from "node:fs";

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

export async function readHookInput() {
  const raw = (await readStdin()).trim();
  return raw ? JSON.parse(raw) : {};
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export async function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return await readStdin();
}
