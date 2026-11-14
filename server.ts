// DocuVault server for Google AI Studio / Cloud Run.
// Serves the app, and is the only part that touches the company Google Drive:
// the owner connects the company account once; after that every approved person's files go to its DocuVault folder.
// Who may read a file is decided by the Firestore security rules: the server reads Firestore as the person asking.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
try { await import('dotenv/config'); } catch { /* .env is optional (AI Studio uses Secrets) */ }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DIST = path.join(HERE, 'dist');
const PROD = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(DIST, 'index.html'));
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const CHAT_FILE_DAYS = Number(process.env.CHAT_FILE_DAYS || 3);
const MAX_CHUNK = 9 * 1024 * 1024;
const FIREBASE = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'firebase-applet-config.json'), 'utf8')); } catch { return {}; } })();
const FIRESTORE = (process.env.DV_FIRESTORE_BASE || 'https://firestore.googleapis.com/v1') + `/projects/${FIREBASE.projectId}/databases/${FIREBASE.firestoreDatabaseId || '(default)'}/documents/`;
// Google endpoints (overridable only for local tests).
const G = { token: process.env.DV_GOOGLE_TOKEN || 'https://oauth2.googleapis.com/token', drive: process.env.DV_GOOGLE_DRIVE || 'https://www.googleapis.com' };

class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC, 'Cache-Control': 'no-store', ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readBody(req, limit): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const readJson = async (req) => { const b = await readBody(req, 1024 * 1024); try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Bad JSON'); } };

/* ---------- secrets: the Drive key and upload sessions are sealed with a key made from the OAuth client secret ---------- */
const KEY = crypto.createHash('sha256').update('docuvault:' + CLIENT_SECRET).digest();
const b64u = (b: Buffer) => b.toString('base64url');
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}
function open(token) {
  try {
    const b = Buffer.from(String(token || ''), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

/* ---------- Firestore, read as the person asking (the security rules decide) ---------- */
function decode(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return fields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
const fields = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, decode(v)]));
async function fsGet(docPath, idToken) {
  if (!FIREBASE.projectId) throw new HttpError(503, 'Firebase is not set up yet. In AI Studio, turn on Firebase for this app.');
  const r = await fetch(FIRESTORE + docPath, { headers: { Authorization: 'Bearer ' + idToken } });
  if (r.status === 404) return null;
  if (r.status === 401) throw new HttpError(401, 'Sign in again.');
  if (r.status === 403) throw new HttpError(403, 'No access.');
  if (!r.ok) throw new HttpError(502, `Database answered ${r.status}`);
  return fields((await r.json()).fields);
}
const userCache = new Map();
async function person(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in again.');
  const hit = userCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  let uid = '';
  try { uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).user_id || ''; } catch { /* checked below */ }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new HttpError(401, 'Sign in again.');
  const u = await fsGet('users/' + uid, token); // Firestore checks the token is real
  if (!u || u.status !== 'approved' || u.active === false) throw new HttpError(403, 'Your account is waiting for approval or turned off.');
  const user = { ...u, id: uid, token };
  userCache.set(token, { user, until: Date.now() + 60000 });
  if (userCache.size > 500) userCache.delete(userCache.keys().next().value);
  return user;
}

/* ---------- the company Google Drive ---------- */
const tokenCache = new Map();
async function driveFor(user) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new HttpError(503, 'The company Google Drive is not set up yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  const cfg = await fsGet('config/drive', user.token);
  const sealed = cfg && open(cfg.enc);
  if (!sealed || !sealed.refresh) throw new HttpError(503, 'The company Google Drive is not connected yet. The owner connects it on the Company Drive page.');
  const hit = tokenCache.get(cfg.enc);
  if (hit && hit.exp > Date.now() + 60000) return { token: hit.token, folderId: cfg.folderId };
  const r = await fetch(G.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: sealed.refresh, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(503, 'Google refused the company Drive connection (' + (j.error || r.status) + '). The owner should connect it again.');
  tokenCache.set(cfg.enc, { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3000) * 1000 });
  return { token: j.access_token, folderId: cfg.folderId };
}
const CALLBACK = '/api/drive/callback';
function connectUrl(origin, keepFolder) {
  const state = seal({ origin, keepFolder: keepFolder || '', exp: Date.now() + 15 * 60000, n: crypto.randomBytes(8).toString('hex') });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: origin + CALLBACK, response_type: 'code', access_type: 'offline', prompt: 'consent',
    include_granted_scopes: 'true', scope: 'openid email https://www.googleapis.com/auth/drive.file', state
  });
}
function popupPage(origin, payload) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>DocuVault</title><body style="font-family:sans-serif;padding:24px">
<p>${payload.error ? 'Could not connect: ' + String(payload.error).replace(/[<>&]/g, '') : 'Company Google Drive connected. You can close this window.'}</p>
<script>try{window.opener&&window.opener.postMessage(Object.assign({type:'dv-drive'},${data}),${JSON.stringify(origin)});}catch(e){}setTimeout(function(){window.close()},1200);</script></body>`;
}
async function driveCallback(url, res) {
  const st = open(url.searchParams.get('state'));
  if (!st || st.exp < Date.now()) return send(res, 400, 'This sign-in link expired. Start again from DocuVault.', { 'Content-Type': 'text/plain' });
  const html = (p) => send(res, 200, popupPage(st.origin, p), { 'Content-Type': 'text/html; charset=utf-8' });
  if (url.searchParams.get('error')) return html({ error: url.searchParams.get('error') });
  const r = await fetch(G.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: st.origin + CALLBACK, grant_type: 'authorization_code' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return html({ error: j.error_description || j.error || 'Google refused the sign-in' });
  if (!j.refresh_token) return html({ error: 'Google did not give a lasting permission. Remove DocuVault at myaccount.google.com/permissions and connect again.' });
  let email = '';
  try { email = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8')).email || ''; } catch { /* optional */ }
  let folderId = st.keepFolder;
  if (folderId) {
    const chk = await fetch(`${G.drive}/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`, { headers: { Authorization: 'Bearer ' + j.access_token } });
    const cj = await chk.json().catch(() => ({}));
    if (!chk.ok || cj.trashed) folderId = '';
  }
  if (!folderId) {
    const f = await fetch(G.drive + '/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + j.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DocuVault', mimeType: 'application/vnd.google-apps.folder', description: 'Files kept by DocuVault. Do not rename or move files in here.' }) });
    const fj = await f.json().catch(() => ({}));
    if (!f.ok) return html({ error: 'Could not create the DocuVault folder in Drive: ' + ((fj.error && fj.error.message) || f.status) });
    folderId = fj.id;
  }
  return html({ enc: seal({ refresh: j.refresh_token }), email, folderId });
}

/* ---------- files ---------- */
const rangeEnd = (h) => { const m = /bytes=0-(\d+)/.exec(String(h || '')); return m ? Number(m[1]) + 1 : 0; };
async function filesApi(name, req, res, url) {
  const user = await person(req);
  if (name === 'start' && req.method === 'POST') {
    const b = await readJson(req);
    const fileId = String(b.fileId || ''), size = Number(b.size);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(fileId) || !Number.isFinite(size) || size < 0 || size > 5 * 1024 ** 3) throw new HttpError(400, 'Bad file');
    const d = await driveFor(user);
    const type = String(b.type || 'application/octet-stream').slice(0, 120);
    const r = await fetch(G.drive + '/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name: String(b.name || 'file').slice(0, 200), parents: [d.folderId], appProperties: { dvId: fileId, by: user.id }, description: `DocuVault file ${fileId} · added by ${user.name || user.email || user.id}` })
    });
    if (!r.ok) throw new HttpError(502, 'Google Drive refused the upload (' + r.status + ').');
    const loc = r.headers.get('location');
    const session = seal({ loc, size, uid: user.id, fileId, exp: Date.now() + 6 * 86400000 });
    if (size === 0) {
      const z = await fetch(loc, { method: 'PUT', headers: { 'Content-Length': '0' } });
      const zj = await z.json().catch(() => ({}));
      return send(res, 200, { session, received: 0, complete: true, driveId: zj.id });
    }
    return send(res, 200, { session, received: 0, complete: false });
  }
  const sessionOf = (tok) => {
    const s = open(tok);
    if (!s || s.exp < Date.now()) return null;
    if (s.uid !== user.id) throw new HttpError(403, 'Not your upload.');
    return s;
  };
  if (name === 'status' && req.method === 'POST') {
    const s = sessionOf((await readJson(req)).session);
    if (!s) return send(res, 200, { expired: true });
    const r = await fetch(s.loc, { method: 'PUT', headers: { 'Content-Range': `bytes */${s.size}`, 'Content-Length': '0' } });
    if (r.status === 308) return send(res, 200, { received: rangeEnd(r.headers.get('range')), complete: false });
    if (r.ok) { const j = await r.json().catch(() => ({})); return send(res, 200, { received: s.size, complete: true, driveId: j.id }); }
    return send(res, 200, { expired: true });
  }
  if (name === 'chunk' && req.method === 'POST') {
    const s = sessionOf(req.headers['x-dv-session']);
    if (!s) throw new HttpError(410, 'The upload expired. It starts again.');
    const offset = Number(url.searchParams.get('offset'));
    const body = await readBody(req, MAX_CHUNK);
    if (!Number.isFinite(offset) || offset < 0 || offset + body.length > s.size || !body.length) throw new HttpError(400, 'Bad piece.');
    const r = await fetch(s.loc, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${offset + body.length - 1}/${s.size}`, 'Content-Length': String(body.length) }, body });
    if (r.status === 308) return send(res, 200, { received: rangeEnd(r.headers.get('range')), complete: false });
    if (r.ok) { const j = await r.json().catch(() => ({})); return send(res, 200, { received: s.size, complete: true, driveId: j.id }); }
    if (r.status === 404 || r.status === 410) throw new HttpError(410, 'The upload expired. It starts again.');
    throw new HttpError(502, 'Google Drive refused a piece (' + r.status + ').');
  }
  if ((name === 'info' || name === 'get') && req.method === 'GET') {
    const id = String(url.searchParams.get('fileId') || '');
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new HttpError(400, 'Bad file id');
    const meta = await fsGet('files/' + id, user.token);
    if (!meta || !meta.driveId) throw new HttpError(404, 'The device that added this file has not uploaded it yet.');
    if (meta.chatOnly && meta.uploadedBy !== user.id && user.role !== 'superadmin' && Date.now() - new Date(meta.at).getTime() > CHAT_FILE_DAYS * 86400000)
      throw new HttpError(403, `Files shared in chat can be opened for ${CHAT_FILE_DAYS} days. Ask the owner for a copy — it is kept in the company Drive.`);
    if (name === 'info') return send(res, 200, { exists: true, size: Number(meta.size || 0), type: meta.type || 'application/octet-stream', name: meta.name || '' });
    const d = await driveFor(user);
    const start = Math.max(0, Number(url.searchParams.get('start') || 0));
    const end = Number(url.searchParams.get('end') ?? Number(meta.size) - 1);
    if (Number(meta.size) === 0) return send(res, 200, Buffer.alloc(0), { 'Content-Type': 'application/octet-stream' });
    if (!(end >= start) || end - start >= MAX_CHUNK) throw new HttpError(400, 'Bad range.');
    const r = await fetch(`${G.drive}/drive/v3/files/${encodeURIComponent(meta.driveId)}?alt=media`, { headers: { Authorization: 'Bearer ' + d.token, Range: `bytes=${start}-${end}` } });
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'The file is no longer in the company Drive.' : 'Google Drive answered ' + r.status);
    res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}) });
    Readable.fromWeb(r.body as any).pipe(res);
    return;
  }
  throw new HttpError(404, 'Not found');
}

async function api(req, res, url) {
  const p = url.pathname.slice('/api/'.length);
  if (p === 'health') return send(res, 200, { ok: true, version: '4.0.0', drive: !!(CLIENT_ID && CLIENT_SECRET), firebase: !!FIREBASE.projectId });
  if (p === 'drive/setup') return send(res, 200, { configured: !!(CLIENT_ID && CLIENT_SECRET), callbackPath: CALLBACK });
  if (p === 'drive/connect') {
    const origin = String(url.searchParams.get('origin') || '').replace(/\/+$/, '');
    if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(origin)) throw new HttpError(400, 'Bad address');
    if (!CLIENT_ID || !CLIENT_SECRET) return send(res, 200, popupPage(origin, { error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on the server yet.' }), { 'Content-Type': 'text/html; charset=utf-8' });
    res.writeHead(302, { ...SEC, Location: connectUrl(origin, String(url.searchParams.get('folder') || '')) }); return res.end();
  }
  if (p === 'drive/callback') return driveCallback(url, res);
  if (p.startsWith('files/')) return filesApi(p.slice(6), req, res, url);
  throw new HttpError(404, 'Not found');
}

/* ---------- the app itself ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveDist(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  let file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { ...SEC, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

let vite = null;
if (!PROD) {
  const { createServer } = await import('vite');
  vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (vite) vite.middlewares(req, res, () => send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }));
    else serveDist(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
    else res.end();
  }
}).listen(PORT, '0.0.0.0', () => console.log(`DocuVault ${PROD ? '(production)' : '(development)'} on http://localhost:${PORT} · Drive ${CLIENT_ID ? 'set up' : 'not set up'} · Firebase ${FIREBASE.projectId || 'not set up'}`));
