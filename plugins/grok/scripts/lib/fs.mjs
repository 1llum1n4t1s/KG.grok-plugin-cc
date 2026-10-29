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

export async function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return await readStdin();
}
