// Cuts a place-names pack release on the merge commit (final architecture 3.4, step 5; README "Release"), after the
// owner approved publishing it in chat. The order keeps the mirrors from ever 404ing: the release bytes and
// places-db.json are already committed on main when the tag is created, and the tag ruleset keeps the tag from moving.
//
//   1. HEAD is a clean checkout of main equal to origin/main, and it carries places/dist/<VERSION>/ and places-db.json;
//   2. the committed bytes match the pointer exactly (check-release.mjs: version, schema, parts, sha256, sizes, URLs);
//   3. the tag bundle-places-<VERSION> exists neither here nor on origin;
//   4. git tag bundle-places-<VERSION> HEAD, git push origin bundle-places-<VERSION>;
//   5. gh release create with the two parts (and the sources archive with --sources, when it changed), the
//      attribution in the notes.
//
// Without --execute it only checks and prints the commands (the default: nothing is tagged or published).
//
// usage: node places/release.mjs [--execute] [--sources <places-sources-<date>.tar.gz>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseProblems } from './check-release.mjs';
import { ATTRIBUTION } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const sources = args.includes('--sources') ? args[args.indexOf('--sources') + 1] : null;
  const version = readFileSync(join(HERE, 'VERSION'), 'utf8').trim();
  const tag = `bundle-places-${version}`;
  const committed = join(HERE, 'dist', version);
  const pointerPath = join(ROOT, 'places-db.json');
  const problems = [];

  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') problems.push('HEAD is not main');
  if (git('status', '--porcelain', '--untracked-files=no')) problems.push('the worktree has uncommitted changes');
  git('fetch', 'origin', 'main', '--tags');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) problems.push('HEAD is not origin/main');
  for (const path of [`places/dist/${version}/places-core.sqlite.gz`, `places/dist/${version}/places-detail.sqlite.gz`, 'places-db.json']) {
    try {
      git('ls-files', '--error-unmatch', path);
    } catch {
      problems.push(`${path} is not committed`);
    }
  }
  problems.push(...releaseProblems({ committed, pointerPath, version }));
  if (git('tag', '--list', tag)) problems.push(`the tag ${tag} exists locally`);
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) problems.push(`the tag ${tag} exists on origin`);
  if (sources && !existsSync(sources)) problems.push(`no sources archive at ${sources}`);

  const files = [join(committed, 'places-core.sqlite.gz'), join(committed, 'places-detail.sqlite.gz'), ...(sources ? [sources] : [])];
  const notes = `Place-names pack ${version} (schema 1): places-core.sqlite.gz and places-detail.sqlite.gz, pinned by places-db.json on the tagged commit.\n\n${ATTRIBUTION}`;
  const commands = [
    ['git', 'tag', tag, 'HEAD'],
    ['git', 'push', 'origin', `refs/tags/${tag}`],
    ['gh', 'release', 'create', tag, ...files, '--title', `Place names ${version}`, '--notes', notes, '--verify-tag'],
  ];
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`ok: ${tag} can be cut on ${git('rev-parse', '--short', 'HEAD')} (${files.map((f) => basename(f)).join(', ')})`);
  for (const c of commands) console.log(`${execute ? 'run' : 'would run'}: ${c.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
  if (!execute) return;
  for (const [cmd, ...rest] of commands) execFileSync(cmd, rest, { cwd: ROOT, stdio: 'inherit' });
}

main();
