import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = process.env.GROK_SIMULATED_ROOT;
process.on('exit', () => fs.writeFileSync(path.join(root, 'agent-exited'), 'exited'));
process.on('SIGTERM', () => process.exit(0));
fs.writeFileSync(path.join(root, 'agent-started'), 'started');
fs.writeFileSync(path.join(root, 'agent-ready'), 'exit handler installed');
setTimeout(() => process.exit(0), 15000);
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  fs.writeFileSync(path.join(root, 'handshake-waiting'), 'waiting');
  while (!fs.existsSync(path.join(root, 'handshake-release'))) await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })}\n`);
});
