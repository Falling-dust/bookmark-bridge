import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicFiles = new Set(['manager.html', 'styles.css', 'app.js', 'background.js', 'manifest.json']);
const publicDirectories = new Set(['lib', 'ui', 'icons', 'examples']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

export function createPreviewServer() {
  return createServer(async (request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(root, '.' + (pathname === '/' ? '/manager.html' : pathname));
      const name = relative(root, path);
      const type = contentTypes[extname(path)];
      const publicPath = publicFiles.has(name) || publicDirectories.has(name.split(sep)[0]);
      if (!type || !publicPath || !path.startsWith(root + sep)) throw new Error('Not found');
      const source = await realpath(path);
      if (!source.startsWith(root + sep) || !(await stat(source)).isFile()) throw new Error('Not found');
      const body = await readFile(source);
      response.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4177);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = createPreviewServer();
  server.on('error', error => { console.error(`Preview server: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Bookmark Bridge demo: http://127.0.0.1:${server.address().port} (sample data only)`));
}
