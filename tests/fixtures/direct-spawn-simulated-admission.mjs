import fs from 'node:fs';
import path from 'node:path';
const root = process.env.GROK_SIMULATED_ROOT;

// The marker and Linux state identity are intentionally simulated, not kernel claims.
export function verifyDirectStartWithinContext(context, token) {
  fs.appendFileSync(path.join(root, 'admission-attempt'), 'attempt\n');
  if (!context || context.epoch !== token.epoch || !fs.existsSync(path.join(root, 'mutex')) ||
      JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).admission !== token.generation) {
    throw new Error('simulated admission changed');
  }
  fs.writeFileSync(path.join(root, 'admission-checked'), 'checked');
  return true;
}
// Old implementations must not pass this check outside the owner mutex.
export function verifyDirectStart() { return true; }
export function finishDirectStart() { return true; }
