// Zero-dependency static file server.
//
// No express, no npm install: Railway's Node builder runs this directly, so
// there is nothing to break in a dependency tree for a site that is a handful
// of static files.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.sumocfg': 'application/xml; charset=utf-8',
};

// Files people are meant to download rather than read in a browser tab.
const ATTACH = new Set(['.sumocfg']);

// Text and the packed run data compress hard (run.bin goes 1.8 MB -> ~210 KB).
// Already-compressed formats are left alone.
const GZIP = new Set(['.html', '.css', '.js', '.json', '.xml', '.txt', '.py',
                      '.svg', '.sumocfg', '.bin']);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and refuse anything that escapes it.
  const target = path.resolve(ROOT, '.' + path.posix.normalize(pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not found: ' + pathname, { 'Content-Type': 'text/plain' });
    }
    const ext = path.extname(target).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The report is regenerated on deploy; data files never change in place.
      'Cache-Control': ext === '.html' ? 'public, max-age=300' : 'public, max-age=86400',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (ATTACH.has(ext)) {
      headers['Content-Disposition'] =
        `attachment; filename="${path.basename(target)}"`;
    }
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const doGzip = wantsGzip && GZIP.has(ext);
    if (doGzip) {
      delete headers['Content-Length'];   // length changes once compressed
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    res.writeHead(200, headers);
    const stream = fs.createReadStream(target);
    if (doGzip) stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    else stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Balagere T Junction study serving on :${PORT}`);
});
