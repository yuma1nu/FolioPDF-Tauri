import { cp, mkdir } from 'node:fs/promises';
import { build, createServer } from 'vite';
await mkdir('public/pdf-assets', { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(`node_modules/pdfjs-dist/${dir}`, `public/pdf-assets/${dir}`, { recursive: true });
}
if (process.argv[2] === 'dev') {
  const server = await createServer();
  await server.listen(); server.printUrls();
} else {
  await import('./notices.mjs');
  await build();
}
