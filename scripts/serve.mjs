import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function createPreviewServer() {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(root, '.' + (pathname === '/' ? '/manager.html' : pathname));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep) || !(await stat(path)).isFile()) throw new Error('Not found');
      const extension = path.split('.').pop();
      response.writeHead(200, { 'Content-Type': ({ html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' })[extension] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(await readFile(path));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4177);
  createPreviewServer().listen(port, '127.0.0.1', () => console.log(`Bookmark Bridge demo: http://127.0.0.1:${port} (sample data only)`));
}
