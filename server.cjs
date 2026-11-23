'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { SqliteConfigStore, createSharedConfigService } = require('./config-api-core.cjs');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function readRequestBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function createAppServer(opts = {}) {
  const staticDir = path.resolve(opts.staticDir || __dirname);
  const dbPath = path.resolve(opts.dbPath || opts.configFilePath || path.join(staticDir, '.tt-data', 'shared-config.sqlite'));
  const store = opts.store || new SqliteConfigStore(dbPath);
  const service = createSharedConfigService({
    store,
    fetchFn: opts.fetchFn,
    geminiApiRoot: opts.geminiApiRoot,
    geminiTimeoutMs: opts.geminiTimeoutMs,
    bootstrapAdmin: opts.bootstrapAdmin
  });

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      if (pathname === '/api/shared-config') {
        if (req.method === 'GET') {
          const out = await service.getConfig();
          return sendJson(res, out.status, out.body);
        }
        if (req.method === 'POST') {
          const raw = await readRequestBody(req);
          const out = await service.updateConfig(raw, req.headers);
          return sendJson(res, out.status, out.body);
        }
        return sendJson(res, 405, { ok: false, errorCode: 'METHOD_NOT_ALLOWED' });
      }

      if (pathname === '/api/gemini/models' && req.method === 'GET') {
        const out = await service.proxyGeminiModels(reqUrl.searchParams, req.headers);
        if (out.rawBody !== undefined) {
          res.writeHead(out.status, { 'Content-Type': out.contentType, 'Cache-Control': 'no-store' });
          return res.end(out.rawBody);
        }
        return sendJson(res, out.status, out.body);
      }

      const genMatch = pathname.match(/^\/api\/gemini\/models\/([^/]+)\/generateContent$/);
      if (genMatch && req.method === 'POST') {
        const raw = await readRequestBody(req);
        const out = await service.proxyGeminiGenerate(decodeURIComponent(genMatch[1]), raw, req.headers);
        if (out.rawBody !== undefined) {
          res.writeHead(out.status, { 'Content-Type': out.contentType, 'Cache-Control': 'no-store' });
          return res.end(out.rawBody);
        }
        return sendJson(res, out.status, out.body);
      }

      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const target = path.resolve(staticDir, rel);
      const blocked = rel.startsWith('.') || rel.endsWith('.cjs') || rel.endsWith('.toml') || rel.startsWith('functions') || rel.startsWith('workers') || rel.startsWith('.tt-data');
      if (blocked || !target.startsWith(staticDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(target).pipe(res);
    } catch (e) {
      sendJson(res, 500, { ok: false, errorCode: 'INTERNAL_ERROR', message: e.message || 'Server error' });
    }
  });

  const closeAll = async () => {
    await new Promise(r => server.close(r));
    if (typeof store.close === 'function' && !opts.keepStoreOpen) store.close();
  };

  return { server, service, store, close: closeAll };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createAppServer({
    dbPath: process.env.TT_SHARED_CONFIG_DB || path.join(__dirname, '.tt-data', 'shared-config.sqlite'),
    geminiApiRoot: process.env.TT_GEMINI_API_ROOT || undefined
  });
  server.listen(port, host, () => {
    console.log(`T&T Mobile Fixed-Origin Server listening at http://${host}:${port}/index.html`);
  });
}

module.exports = { createAppServer };
