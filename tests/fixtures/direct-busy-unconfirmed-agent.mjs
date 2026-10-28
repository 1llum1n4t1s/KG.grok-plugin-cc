import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log('fake grok 1.0');
  process.exit(0);
}
const root = process.env.GROK_BUSY_TEST_ROOT;
const record = JSON.parse(fs.readFileSync(process.env.GROK_BUSY_TEST_STATE, 'utf8')).jobs.find(job => job.status === 'running');
if (!record?.grokDirectGeneration) throw new Error('direct generation missing at agent startup');
let number = 1;
while (true) {
  try {
    fs.writeFileSync(path.join(root, `agent-${number}-started`), JSON.stringify({ jobId: record.id, generation: record.grokDirectGeneration }), { flag: 'wx' });
    break;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    number++;
  }
}
process.on('SIGTERM', () => fs.writeFileSync(path.join(root, `agent-${number}-sigterm`), 'ignored'));
process.on('exit', () => fs.writeFileSync(path.join(root, `agent-${number}-exited`), 'exited'));
// This timer remains active after stdin is closed, so an abandoned agent exits itself.
setTimeout(() => process.exit(0), 12000);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'fake busy' } })}\n`);
  }
});
