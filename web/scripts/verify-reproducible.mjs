#!/usr/bin/env node
/**
 * HARDWARE DOG / REPRODUCIBLE BUILD
 *
 * Builds the interface and the command line twice, from clean, and
 * compares every byte. Same sources, same lockfile: same files, so anyone
 * can check that what is published is what the code builds.
 *
 *   npm run build:verify      (CI runs it on every push to main)
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const files = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

function digest(dir) {
  const out = new Map();
  for (const f of files(dir).sort()) out.set(relative(dir, f), createHash('sha256').update(readFileSync(f)).digest('hex'));
  return out;
}

function build(n) {
  const web = mkdtempSync(join(tmpdir(), `hwdog-web-${n}-`));
  const cli = mkdtempSync(join(tmpdir(), `hwdog-cli-${n}-`));
  rmSync('node_modules/.vite', { recursive: true, force: true });
  execSync(`npx vite build --outDir ${web} --emptyOutDir`, { stdio: 'ignore' });
  execSync(`npx vite build --config vite.cli.config.ts --outDir ${cli} --emptyOutDir`, { stdio: 'ignore' });
  return { web: digest(web), cli: digest(cli), dirs: [web, cli] };
}

const a = build(1);
const b = build(2);
let differ = 0;
for (const part of ['web', 'cli']) {
  const names = new Set([...a[part].keys(), ...b[part].keys()]);
  for (const name of [...names].sort()) {
    if (a[part].get(name) !== b[part].get(name)) {
      differ++;
      console.log(`DIFFERS  ${part}/${name}`);
    }
  }
}
for (const d of [...a.dirs, ...b.dirs]) rmSync(d, { recursive: true, force: true });
const count = a.web.size + a.cli.size;
console.log(differ ? `${differ} of ${count} file(s) differ: the build is not reproducible` : `REPRODUCIBLE  ${count} files, byte for byte`);
for (const [name, sha] of [...a.web].filter(([n]) => n.endsWith('.html'))) console.log(`  ${sha}  web/${name}`);
for (const [name, sha] of [...a.cli].filter(([n]) => n.endsWith('.mjs'))) console.log(`  ${sha}  cli/${name}`);
process.exit(differ ? 1 : 0);
