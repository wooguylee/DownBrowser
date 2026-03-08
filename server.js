const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 3187);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const requestPath = req.url === '/' ? '/demo.html' : req.url;
  const filePath = path.join(root, requestPath.replace(/^\/+/, ''));

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (mimeTypes[ext]) {
      res.setHeader('content-type', mimeTypes[ext]);
    }
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Demo server listening on http://127.0.0.1:${port}`);
});
