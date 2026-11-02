// The HTTP handler: the JSON API under /api/ and the static page from public/.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { validatePhoto, validateRecipe } from './validate.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
/** Largest request body read: a 2 MB photo is about 2.8 MB as base64. */
const MAX_BODY = 4 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  if (body === undefined) return void res.writeHead(status).end();
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read the whole body (draining anything past MAX_BODY) and parse it as JSON. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'The request body is too large.'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'The body is not valid JSON.'));
      }
    });
  });
}

function serveStatic(req, res) {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
  let file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

export function createApp(dataFile) {
  const store = openStore(dataFile);

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    if (parts[0] !== 'recipes' || parts.length > 3) throw new HttpError(404, 'Not found');
    const method = req.method;

    if (parts.length === 1) {
      if (method === 'GET')
        return send(
          res,
          200,
          store.list({ q: url.searchParams.get('q'), tag: url.searchParams.get('tag') }),
        );
      if (method === 'POST') {
        const { value, error } = validateRecipe(await readJson(req));
        if (error) throw new HttpError(400, error);
        return send(res, 201, store.create(value));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const id = /^[1-9]\d*$/.test(parts[1]) ? Number(parts[1]) : null;
    const recipe = id && store.get(id);
    if (!recipe) throw new HttpError(404, 'No such recipe');

    if (parts.length === 2) {
      if (method === 'GET') return send(res, 200, recipe);
      if (method === 'PUT') {
        const { value, error } = validateRecipe(await readJson(req));
        if (error) throw new HttpError(400, error);
        return send(res, 200, store.update(id, value));
      }
      if (method === 'DELETE') {
        store.remove(id);
        return send(res, 204);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (parts[2] !== 'photo') throw new HttpError(404, 'Not found');
    if (method === 'GET') {
      const photo = store.getPhoto(id);
      if (!photo) throw new HttpError(404, 'This recipe has no photo');
      res.writeHead(200, { 'content-type': photo.type, 'content-length': photo.bytes.length });
      return void res.end(photo.bytes);
    }
    if (method === 'POST') {
      const { value, error, status } = validatePhoto(await readJson(req));
      if (error) throw new HttpError(status, error);
      return send(res, 200, store.setPhoto(id, value.bytes, value.type));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res);
      else throw new HttpError(405, 'Method not allowed');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent)
        send(res, e.status ?? 500, { error: e.status ? e.message : 'Server error' });
    }
  });
  server.on('close', () => store.close());
  return server;
}
