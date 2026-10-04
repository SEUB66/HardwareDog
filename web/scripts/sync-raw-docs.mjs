// engineering.html shows docs/*.md raw, as they are in the repository.
// This copies them in again, escaped; test/raw-docs.test.ts fails when the
// page and the docs disagree. Run: npm run docs:sync
import { readFileSync, writeFileSync } from 'node:fs';

const page = new URL('../engineering.html', import.meta.url);
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
let html = readFileSync(page, 'utf8');
const found = [];
html = html.replace(/(<pre tabindex="0" aria-label="([A-Z_]+\.md) raw source">)([\s\S]*?)(<\/pre>)/g, (_, open, name, _body, close) => {
  found.push(name);
  return open + escape(readFileSync(new URL(`../../docs/${name}`, import.meta.url), 'utf8')) + close;
});
writeFileSync(page, html);
console.log(`engineering.html: ${found.join(', ')} copied from docs/`);
