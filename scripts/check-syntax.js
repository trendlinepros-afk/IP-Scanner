'use strict';

/**
 * Zero-dependency sanity check: byte-compile every project .js file with
 * `node --check` and validate JSON assets parse.  Run with `npm run lint`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const jsDirs = ['src', 'scripts'];
const jsonFiles = ['package.json', 'data/oui.json'];

let failures = 0;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

console.log('Checking JavaScript syntax…');
for (const dir of jsDirs) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log(`  ok  ${path.relative(root, file)}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL ${path.relative(root, file)}`);
      console.error(String(err.stderr || err.message).trim());
    }
  }
}

console.log('Checking JSON assets…');
for (const rel of jsonFiles) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  try {
    JSON.parse(fs.readFileSync(abs, 'utf8'));
    console.log(`  ok  ${rel}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${rel}: ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed validation.`);
  process.exit(1);
}
console.log('\nAll files valid.');
