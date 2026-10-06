// Copy the package version into the manifest of each built-in bundle.
//
// The built-in bundles ship inside the package, so their version is the
// package version. "npm version" runs this script after it changes
// package.json and before it commits, through the "version" lifecycle script.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const builtinRoot = path.join(root, 'builtin');

for (const entry of readdirSync(builtinRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const manifest = path.join(builtinRoot, entry.name, 'hcm.yaml');
  const before = readFileSync(manifest, 'utf8');
  const after = before.replace(/^version:.*$/m, `version: ${version}`);

  if (after === before) continue;
  writeFileSync(manifest, after);
  console.log(`${path.relative(root, manifest)} -> ${version}`);
}
