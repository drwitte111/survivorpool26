// Stamps sw.js with a unique build id at deploy time.
//
// This replaces what used to be a hand-edited `const VERSION = 'v6'`. Two people
// working in the same week both had to bump that line, so it conflicted every
// time. Netlify runs this during the build against a throwaway checkout, so the
// committed sw.js always keeps its '__BUILD_ID__' placeholder.
import { readFileSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = "const BUILD_ID = '__BUILD_ID__';";
const FILE = 'sw.js';

// Netlify exposes the commit SHA as COMMIT_REF. Fall back to a timestamp so the
// script still produces a unique id anywhere else.
const raw = process.env.COMMIT_REF || process.env.BUILD_ID || `local-${Date.now()}`;
const id = raw.slice(0, 12).replace(/[^A-Za-z0-9._-]/g, '');

const src = readFileSync(FILE, 'utf8');
if(!src.includes(PLACEHOLDER)){
  console.error(`stamp-build: placeholder not found in ${FILE}.`);
  console.error('Expected exactly this line:');
  console.error(`  ${PLACEHOLDER}`);
  process.exit(1);
}

writeFileSync(FILE, src.replace(PLACEHOLDER, `const BUILD_ID = '${id}';`));
console.log(`stamp-build: ${FILE} stamped with build id ${id}`);
