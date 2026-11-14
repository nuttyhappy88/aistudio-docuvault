// Keeps this device's copy (IndexedDB) in step with Firestore, and moves files to and from the company Google Drive
// through this app's server. Works offline: changes wait in the outbox, files wait on the device.
import { raw, SYNCED, getSetting, setSetting, clearSharedData } from './db.js';
import * as cloud from './cloud.js';

export const sync = {
  status: 'idle',      // idle | syncing | ok | offline | auth | error
  pending: 0,
  lastSync: null,
  lastError: '',
  rejected: [],        // [{store, id, error}]
  upload: null         // { index, count, name, sent, size, doneBytes, totalBytes, error }
};
const listeners = new Set();
export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (evt) => listeners.forEach(fn => { try { fn(evt); } catch (_) { /* ignore */ } });

/* ---------- who is signed in ---------- */
// account: the Google account. profile: the DocuVault user record (role, businesses, approval).
export const session = { state: 'loading', account: null, profile: null, error: '' };
// state: loading | unconfigured | signedOut | needsSetup | pending | declined | disabled | ready
let profileUnsub = null;
const publicProfile = (p) => p && ({
  id: p.id, name: p.name, email: p.email, photo: p.photo || '', role: p.role, businesses: p.businesses || [], departments: p.departments || [],
  awayUntil: Number(p.awayUntil || 0), backupId: p.backupId || null, active: p.active !== false && p.status === 'approved', status: p.status, mustChange: false
});
export function startSession() {
  if (!cloud.cloudConfigured) { session.state = 'unconfigured'; emit('session'); return; }
  cloud.onAuth(async (acc) => {
    stopListeners();
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    session.account = acc; session.profile = null; session.error = '';
    if (!acc) { session.state = 'signedOut'; emit('session'); return; }
    const prev = await getSetting('me');
    if (prev && prev.id !== acc.uid) await clearSharedData(); // someone else used this device before
    // Offline start: trust what this device knew last time.
    if (!navigator.onLine && prev && prev.id === acc.uid && prev.active) { session.profile = prev; session.state = 'ready'; emit('session'); return; }
    try {
      let p = await cloud.getData('users', acc.uid);
      if (!p) {
        const owner = await cloud.getData('config', 'owner').catch(() => null);
        if (!owner) { session.state = 'needsSetup'; emit('session'); return; }
        const invite = await cloud.getData('invites', acc.email).catch(() => null);
        p = invite
          ? { id: acc.uid, email: acc.email, name: acc.name, photo: acc.photo, role: invite.role, businesses: invite.businesses || [], departments: invite.departments || [], status: 'approved', active: true, invited: true, createdAt: new Date().toISOString() }
          : { id: acc.uid, email: acc.email, name: acc.name, photo: acc.photo, role: 'viewer', businesses: [], departments: [], status: 'pending', active: true, createdAt: new Date().toISOString() };
        await cloud.setData('users', acc.uid, p);
      } else {
        cloud.setData('users', acc.uid, { lastLogin: new Date().toISOString(), photo: acc.photo }, true).catch(() => {});
      }
      watchProfile(acc.uid);
      applyProfile(p);
    } catch (e) {
      if (prev && prev.id === acc.uid && prev.active) { session.profile = prev; session.state = 'ready'; emit('session'); return; }
      session.state = 'signedOut'; session.error = 'Could not reach DocuVault: ' + (e.message || e); emit('session');
    }
  });
}
function applyProfile(p) {
  const me = publicProfile(p);
  const was = session.state;
  session.profile = me;
  session.state = p.status === 'pending' ? 'pending' : p.status === 'declined' ? 'declined' : p.active === false ? 'disabled' : 'ready';
  setSetting('me', session.state === 'ready' ? me : null);
  if (session.state === 'ready') { if (was !== 'ready' || !active.length) startListeners(me); }
  else stopListeners();
  emit('session');
}
function watchProfile(uid) {
  profileUnsub = cloud.listen('users', [['__id__', '==', uid]], (changes) => {
    const c = changes.find(x => x.id === uid);
    if (c && c.type !== 'removed') {
      const before = JSON.stringify(session.profile && [session.profile.role, session.profile.businesses, session.profile.status, session.profile.active]);
      const after = publicProfile(c.data);
      const changed = before !== JSON.stringify([after.role, after.businesses, after.status, after.active]);
      if (changed && session.state === 'ready') stopListeners();
      applyProfile(c.data);
    }
    if (c && c.type === 'removed') { session.state = 'declined'; stopListeners(); emit('session'); }
  });
}
export const signIn = () => cloud.signInGoogle();
export async function signOutNow() { stopListeners(); if (profileUnsub) profileUnsub(); profileUnsub = null; await setSetting('me', null); await cloud.signOutCloud(); }

// First sign-in ever: this Google account becomes the owner (super admin) and creates the first business.
export async function setupOwner({ bizName, bizCode }) {
  const acc = session.account;
  const now = new Date().toISOString();
  const profile = { id: acc.uid, email: acc.email, name: acc.name, photo: acc.photo, role: 'superadmin', businesses: [], departments: [], status: 'approved', active: true, createdAt: now };
  await cloud.batchWrite([
    { col: 'config', id: 'owner', data: { uid: acc.uid, email: acc.email, at: now } },
    { col: 'users', id: acc.uid, data: profile }
  ]);
  watchProfile(acc.uid);
  applyProfile(profile);
  return { now };
}

/* ---------- live copies of the data this person may see ---------- */
let active = [];
function stopListeners() { active.forEach(u => { try { u(); } catch (_) { /* ignore */ } }); active = []; }
const chunks = (arr, n = 30) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
let dataTimer = null;
const dataSoon = () => { clearTimeout(dataTimer); dataTimer = setTimeout(() => emit('data'), 120); };
function startListeners(me) {
  stopListeners();
  const S = me.role === 'superadmin', uid = me.id;
  const biz = me.businesses || [];
  const canFile = ['superadmin', 'bizadmin', 'manager', 'staff'].includes(me.role);
  const qs = [];
  if (S) {
    for (const c of ['businesses', 'folders', 'docs', 'workflows', 'routes', 'audit', 'announcements']) qs.push([c, []]);
    qs.push(['rooms', [['kind', '==', 'channel']]], ['messages', [['kind', '==', 'channel']]]);
    qs.push(['users', []], ['invites', []]);
  } else {
    for (const ch of chunks(biz)) {
      qs.push(['businesses', [['__id__', 'in', ch]]]);
      for (const c of ['folders', 'docs', 'workflows', 'routes', 'announcements']) qs.push([c, [['bizId', 'in', ch]]]);
      if (me.role === 'bizadmin') qs.push(['audit', [['bizId', 'in', ch]]]);
      qs.push(['rooms', [['kind', '==', 'channel'], ['bizId', 'in', ch]]], ['messages', [['kind', '==', 'channel'], ['bizId', 'in', ch]]]);
    }
    qs.push(['announcements', [['bizId', '==', null]]]);
    qs.push(['users', [['status', '==', 'approved']]]);
  }
  if (canFile) qs.push(['inbox', []]);
  qs.push(['rooms', [['members', 'array-contains', uid]]], ['messages', [['members', 'array-contains', uid]]]);
  qs.push(['notifications', [['userId', '==', uid]]]);
  let first = qs.length;
  sync.status = 'syncing'; emit('status');
  for (const [col, filters] of qs) {
    let seenFirst = false;
    active.push(cloud.listen(col, filters, async (changes, fromCache) => {
      const pending = new Set((await raw.all('outbox')).map(o => o.id));
      for (const c of changes) {
        const store = col === 'invites' ? 'invites' : col;
        if (col === 'users' || col === 'invites') {
          if (c.type === 'removed') await raw.del(store, c.id); else await raw.put(store, col === 'users' ? publicProfile({ ...c.data, id: c.id }) : { ...c.data, id: c.id });
          continue;
        }
        if (pending.has(`${col}:${c.id}`)) continue; // our newer change is still waiting to be sent
        if (c.type === 'removed') await raw.del(col, c.id); else await raw.put(col, { ...c.data, id: c.id });
      }
      if (!seenFirst) { seenFirst = true; if (--first === 0) { sync.status = navigator.onLine ? 'ok' : 'offline'; sync.lastSync = new Date(); emit('status'); } }
      else if (!fromCache) { sync.lastSync = new Date(); sync.status = 'ok'; emit('status'); }
      if (changes.length) dataSoon();
    }, (e) => {
      console.warn('DocuVault: could not read', col, e.code || e.message);
      if (!seenFirst) { seenFirst = true; if (--first === 0) { sync.status = 'ok'; emit('status'); } }
      if (e.code === 'permission-denied') return;
      sync.status = 'error'; sync.lastError = e.message; emit('status');
    }));
  }
  syncSoon();
}

/* ---------- sending this device's changes ---------- */
const me = () => session.profile;
const pad = (n, w = 4) => String(n).padStart(w, '0');
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { code: 'unavailable' })), ms))]);
async function prepare(store, data) {
  const u = me();
  if (store === 'docs' && data && !data.code) {
    const biz = await raw.get('businesses', data.bizId);
    if (!biz) throw Object.assign(new Error('Unknown business'), { code: 'invalid-argument' });
    const year = new Date().getFullYear();
    const n = await withTimeout(cloud.nextNumber(`${data.bizId}_${year}`), 15000, 'No connection');
    data = { ...data, code: `${biz.code}-${year}-${pad(n)}`, trackPin: data.trackPin || String(100000 + Math.floor(Math.random() * 900000)), createdBy: data.createdBy || u.id };
    await raw.put('docs', data); // show the code right away
  }
  if (store === 'messages' && data) {
    const room = await raw.get('rooms', data.roomId);
    if (room) data = { ...data, kind: room.kind === 'channel' ? 'channel' : 'private', bizId: room.kind === 'channel' ? room.bizId : null, members: room.kind === 'channel' ? [] : room.members };
    data.by = data.by || u.id;
  }
  if (store === 'rooms' && data) data = { ...data, members: data.kind === 'channel' ? [] : (data.members || []) };
  if (store === 'notifications' && data && !data.fromId) data = { ...data, fromId: u.id, fromName: u.name };
  if (store === 'audit' && data) data = { ...data, userId: u.id };
  return data;
}
// Requesters track their document with code + PIN, without signing in. Only a short summary is shared.
async function publishTracking(docRec) {
  if (!docRec || !docRec.code || !docRec.trackPin) return;
  const biz = await raw.get('businesses', docRec.bizId);
  const runs = (await raw.all('routes')).filter(r => r.docId === docRec.id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const run = runs[0];
  await cloud.setData('track', `${docRec.code}_${docRec.trackPin}`, {
    code: docRec.code, type: docRec.type || '', business: biz ? biz.name : '', received: docRec.received || docRec.createdAt || '', bizId: docRec.bizId,
    workflow: run ? { name: run.name, status: run.status, current: run.current, updated: run.history && run.history.length ? run.history[run.history.length - 1].at : run.startedAt,
      steps: (run.steps || []).map(s => ({ name: s.name, status: s.status, doneAt: s.doneAt || null })) } : null
  });
}
async function pushChanges() {
  const out = (await raw.all('outbox')).sort((a, b) => a.at - b.at);
  for (const o of out) {
    try {
      const data = o.deleted ? null : await prepare(o.store, o.data);
      if (data) await withTimeout(cloud.setData(o.store, o.recId, data), 20000, 'No connection');
      else await withTimeout(cloud.deleteData(o.store, o.recId), 20000, 'No connection');
      const now = await raw.get('outbox', o.id);
      if (now && now.at === o.at) await raw.del('outbox', o.id);
      try {
        if (o.store === 'docs' && data) await publishTracking(data);
        if (o.store === 'routes' && data) await publishTracking(await raw.get('docs', data.docId));
      } catch (_) { /* tracking is best effort */ }
    } catch (e) {
      const code = e.code || '';
      if (/unavailable|deadline|network|failed-precondition/.test(code) || !navigator.onLine) throw Object.assign(new Error('offline'), { status: 0 });
      // Refused (no permission or bad data): drop it and report.
      await raw.del('outbox', o.id);
      sync.rejected.push({ store: o.store, id: o.recId, error: /permission/.test(code) ? 'You do not have permission for this change.' : (e.message || 'Refused') });
      // Put back what the server has.
      try { const cur = await cloud.getData(o.store, o.recId); if (cur) await raw.put(o.store, { ...cur, id: o.recId }); else await raw.del(o.store, o.recId); } catch (_) { /* ignore */ }
    }
  }
}

let running = null, again = false;
export function syncNow() {
  if (session.state !== 'ready') return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      await pushChanges();
      if (sync.status !== 'syncing') sync.status = navigator.onLine ? 'ok' : 'offline';
      sync.lastError = '';
      if (sync.rejected.length) emit('rejected');
    } catch (e) {
      sync.status = e.status === 0 ? 'offline' : 'error';
      sync.lastError = e.message;
    } finally {
      sync.pending = await raw.count('outbox') + (await raw.all('files')).filter(f => !f.uploaded).length;
      emit('status');
    }
    if (sync.status !== 'offline') startUploads();
  })().finally(() => { running = null; if (again) { again = false; syncNow(); } });
  return running;
}
let debounce;
export function syncSoon() { clearTimeout(debounce); debounce = setTimeout(syncNow, 500); }
export function startAutoSync() {
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 30000);
  window.addEventListener('online', () => { sync.status = 'ok'; syncNow(); });
  window.addEventListener('offline', () => { sync.status = 'offline'; emit('status'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}

/* ---------- this app's server (company Google Drive) ---------- */
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
const offlineMsg = 'No internet connection. It continues when you are back online.';
export async function serverApi(path, { method = 'GET', json, body, headers = {}, raw: wantRaw = false } = {}) {
  let res;
  try {
    const t = await cloud.idToken();
    res = await fetch('/api/' + path.replace(/^\//, ''), {
      method, body: json !== undefined ? JSON.stringify(json) : body, cache: 'no-store',
      headers: { ...headers, ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) }
    });
  } catch (_) { throw new ApiError(offlineMsg, 0); }
  if (wantRaw && res.ok) return res;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError((data && data.error) || `Server error ${res.status}`, res.status);
  return data;
}

/* ---------- files: up to and down from the company Drive, 4 MB at a time ---------- */
const CHUNK = 4 * 1024 * 1024;
async function uploadFiles() {
  const files = (await raw.all('files')).filter(f => !f.uploaded);
  const totalBytes = files.reduce((a, f) => a + f.blob.size, 0);
  let doneBytes = 0;
  const report = (i, f, sent) => { sync.upload = { index: i + 1, count: files.length, name: f.name || 'file', sent, size: f.blob.size, doneBytes: doneBytes + sent, totalBytes, error: '' }; emit('upload'); };
  for (let i = 0; i < files.length; i++) {
    let f = files[i];
    report(i, f, 0);
    let st;
    if (f.session) { try { st = await serverApi('files/status', { method: 'POST', json: { session: f.session } }); } catch (e) { if (e.status === 0) throw e; st = null; } }
    if (!st || st.expired) {
      st = await serverApi('files/start', { method: 'POST', json: { fileId: f.id, name: f.name || 'file', type: f.type || 'application/octet-stream', size: f.blob.size } });
      f = { ...f, session: st.session }; await raw.put('files', f);
    }
    let offset = st.received || 0;
    while (!st.complete) {
      report(i, f, offset);
      const piece = f.blob.slice(offset, Math.min(f.blob.size, offset + CHUNK));
      const res = await serverApi(`files/chunk?offset=${offset}`, { method: 'POST', body: piece, headers: { 'Content-Type': 'application/octet-stream', 'X-DV-Session': f.session } });
      st = res; offset = res.received;
    }
    await cloud.setData('files', f.id, { driveId: st.driveId, name: f.name || 'file', type: f.type || 'application/octet-stream', size: f.blob.size, uploadedBy: me().id, at: new Date().toISOString(), chatOnly: !!f.chatOnly });
    await raw.put('files', { ...f, uploaded: true, session: null });
    doneBytes += f.blob.size;
  }
}
let uploading = null;
function startUploads() {
  if (uploading || session.state !== 'ready') return uploading;
  uploading = (async () => {
    try { await uploadFiles(); sync.upload = null; }
    catch (e) { sync.upload = { ...(sync.upload || {}), error: e.status === 0 ? 'Waiting for internet to continue the upload.' : e.message }; }
    finally { sync.pending = await raw.count('outbox') + (await raw.all('files')).filter(f => !f.uploaded).length; emit('upload'); emit('status'); }
  })().finally(() => { uploading = null; });
  return uploading;
}
export const filesUploading = () => !!uploading;
// A file stored once in chat can later be kept for good (sent to the Inbox or filed).
export async function keepFile(id) { try { await cloud.setData('files', id, { chatOnly: false }, true); } catch (_) { /* uploads later with the flag off */ } const f = await raw.get('files', id); if (f && f.chatOnly) await raw.put('files', { ...f, chatOnly: false }); }

export async function fetchFile(id) {
  let info;
  try { info = await serverApi(`files/info?fileId=${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 0) throw new Error('This file is in the company Google Drive. Connect to the internet to open it.'); throw new Error(e.message); }
  const parts = [];
  for (let start = 0; start < info.size; start += CHUNK) {
    const end = Math.min(info.size, start + CHUNK) - 1;
    const res = await serverApi(`files/get?fileId=${encodeURIComponent(id)}&start=${start}&end=${end}`, { raw: true });
    parts.push(await res.blob());
  }
  const blob = new Blob(parts, { type: info.type || 'application/octet-stream' });
  const rec = { id, blob, name: info.name || '', type: blob.type, size: blob.size, uploaded: true };
  await raw.put('files', rec);
  return rec;
}

/* ---------- people (super admin) ---------- */
export const users = {
  update: (uid, fields) => cloud.setData('users', uid, fields, true),
  approve: (uid, fields) => cloud.setData('users', uid, { ...fields, status: 'approved', active: true, approvedAt: new Date().toISOString(), approvedBy: me().id }, true),
  decline: (uid) => cloud.setData('users', uid, { status: 'declined' }, true),
  remove: (uid) => cloud.deleteData('users', uid),
  invite: (email, fields) => cloud.setData('invites', email.trim().toLowerCase(), { email: email.trim().toLowerCase(), ...fields, by: me().id, at: new Date().toISOString() }),
  uninvite: (email) => cloud.deleteData('invites', email)
};
export const setAway = (until, backupId) => cloud.setData('users', me().id, { awayUntil: until, backupId: backupId || null }, true);

/* ---------- company Drive connection and settings ---------- */
export const getConfig = (id) => cloud.getData('config', id);
export const setConfig = (id, data, merge = true) => cloud.setData('config', id, data, merge);
export const getTracking = (code, pin) => cloud.getData('track', `${code}_${pin}`);
export const writeMany = (ops) => cloud.batchWrite(ops);
export const firebaseInfo = cloud.firebaseInfo;
