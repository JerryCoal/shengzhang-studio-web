import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
const require = createRequire(import.meta.url);
async function preparePDFResources() {
  const root = dirname(require.resolve('pdfjs-dist/package.json')), zip = new JSZip();
  for (const folder of ['cmaps', 'standard_fonts']) for (const name of await readdir(join(root, folder))) zip.file(`${folder}/${name}`, await readFile(join(root, folder, name)));
  zip.file('LICENSE-pdfjs.txt', await readFile(join(root, 'LICENSE')));
  await writeFile('public/pdf-resources.zip', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
export default defineConfig(({ mode }) => ({
  base: mode === 'static' ? './' : '/',
  plugins: [react(), { name: 'local-pdf-resources', buildStart: preparePDFResources }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4318' } },
  build: { target: 'es2022' },
}));
