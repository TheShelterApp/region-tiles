// Full idempotent pipeline: stage -> normalize -> simplify -> index -> version -> validate.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../config.mjs';

const steps = [
  ['00-stage-sources.mjs', process.argv.includes('--restage') ? ['--force'] : []],
  ['01-normalize.mjs', []],
  ['02-simplify.mjs', []],
  ['03-index.mjs', []],
  ['04-version.mjs', []],
  ['05-validate.mjs', []],
];

for (const [file, args] of steps) {
  console.log(`\n===== ${file} ${args.join(' ')} =====`);
  execFileSync('node', [join(ROOT, 'pipeline', file), ...args], { stdio: 'inherit' });
}
console.log('\nBuild complete. Outputs: geo/  index/  version.json');
