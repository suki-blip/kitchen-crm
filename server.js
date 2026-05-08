// Tiny static file server for the Kitchen CRM prototype.
// Usage: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2], 10) || 5180;
const root = __dirname;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback to index for hash routes is automatic (browser handles hash);
      // but if a deep path is requested we still serve index.
      if (urlPath !== '/index.html') {
        const fallback = path.join(root, 'index.html');
        return fs.readFile(fallback, (e, data) => {
          if (e) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': mime['.html'] });
          res.end(data);
        });
      }
      res.writeHead(404); return res.end('Not found');
    }
    fs.readFile(filePath, (e, data) => {
      if (e) { res.writeHead(500); return res.end('Server error'); }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': mime[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
}).listen(port, '127.0.0.1', () => {
  console.log('Kitchen CRM running at http://localhost:' + port);
});
