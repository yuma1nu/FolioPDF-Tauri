import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const seen = new Set();
let text = 'Folio PDF — Third-party notices\n\nTauri uses the Windows WebView2 system runtime. Rust dependency versions are recorded in Cargo.lock; refer to each crate source distribution for its license. This file covers bundled JavaScript dependencies.\n\n';
async function include(name, req) {
  let location;
  try { location = req.resolve(`${name}/package.json`); }
  catch {
    let dir = dirname(req.resolve(name));
    for (;;) {
      const file = join(dir, 'package.json');
      try { if (JSON.parse(await readFile(file, 'utf8')).name === name) { location = file; break; } } catch {}
      const parent = dirname(dir); if (parent === dir) throw new Error(`Missing package metadata: ${name}`); dir = parent;
    }
  }
  const pkg = JSON.parse(await readFile(location, 'utf8'));
  const id = `${pkg.name}@${pkg.version}`; if (seen.has(id)) return; seen.add(id);
  text += `\n===== ${id} (${pkg.license ?? 'see notice'}) =====\n`;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.TXT', 'CopyrightNotice.txt']) {
    try { text += await readFile(join(dirname(location), file), 'utf8'); break; } catch {}
  }
  text += '\n';
  const child = createRequire(location);
  for (const dep of Object.keys(pkg.dependencies ?? {})) await include(dep, child);
}
const req = createRequire(import.meta.url);
for (const name of ['react', 'react-dom', 'pdfjs-dist', 'pdf-lib', 'lucide-react', '@tauri-apps/api']) await include(name, req);
await writeFile('THIRD_PARTY_NOTICES.txt', text);
console.log(`Third-party notices: ${seen.size} packages`);

