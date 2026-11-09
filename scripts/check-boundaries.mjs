// Enforces the architecture's dependency rules:
//  - src/core/**   must not import from src/ui, src/app or src/styles
//  - src/styles/** may only import '@core/plugin-api' (plus files inside its own style folder)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const src = join(root, 'src');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
})(src);

const importRe = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const errors = [];
for (const file of files) {
  const rel = relative(src, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(importRe)) {
    const spec = m[1] ?? m[2];
    const target = spec.startsWith('.') ? relative(src, resolve(dirname(file), spec)).split(sep).join('/') : spec;
    if (rel.startsWith('core/') && /^(ui|app|styles)\//.test(target)) {
      errors.push(`${rel}: core must not import "${spec}"`);
    }
    if (rel.startsWith('styles/')) {
      const styleDir = rel.split('/').slice(0, 2).join('/');
      const ok = spec === '@core/plugin-api' || (spec.startsWith('.') && target.startsWith(styleDir + '/'));
      if (!ok) errors.push(`${rel}: styles may only import "@core/plugin-api" or their own files, not "${spec}"`);
    }
  }
}
if (errors.length) {
  console.error('Architecture boundary violations:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`Boundaries OK (${files.length} files checked).`);
