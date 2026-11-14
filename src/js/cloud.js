// The only file that talks to Firebase (Google sign-in + Firestore). Everything else uses these functions,
// so the rest of the app does not depend on Firebase details.
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, deleteDoc,
  collection, query, where, documentId, onSnapshot, writeBatch, runTransaction
} from 'firebase/firestore';
import cfg from '../../firebase-applet-config.json';

export const cloudConfigured = !!(cfg && cfg.projectId && cfg.apiKey);
export const firebaseInfo = { projectId: cfg.projectId || '', databaseId: cfg.firestoreDatabaseId || '(default)' };

let app, auth, fs;
function init() {
  if (fs || !cloudConfigured) return;
  app = initializeApp(cfg);
  auth = getAuth(app);
  const settings = { ignoreUndefinedProperties: true };
  try { settings.localCache = persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch (_) { /* private window: memory only */ }
  fs = initializeFirestore(app, settings, cfg.firestoreDatabaseId || undefined);
}

/* ---------- Google sign-in ---------- */
const toUser = (u) => u && { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.displayName || u.email || 'User', photo: u.photoURL || '' };
export function onAuth(cb) {
  init();
  if (!auth) { cb(null); return () => {}; }
  getRedirectResult(auth).catch(() => {});
  return onAuthStateChanged(auth, (u) => cb(toUser(u)));
}
export async function signInGoogle() {
  init();
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    // Installed apps on some phones block pop-ups: use a full-page sign-in instead.
    if (/popup-blocked|operation-not-supported|cancelled-popup/.test(e.code || '')) return signInWithRedirect(auth, p);
    throw e;
  }
}
export const signOutCloud = () => (auth ? signOut(auth) : Promise.resolve());
export const idToken = async () => (auth && auth.currentUser ? auth.currentUser.getIdToken() : '');

/* ---------- Firestore ---------- */
const clean = (v) => JSON.parse(JSON.stringify(v)); // plain data only (no undefined, no class instances)
export async function getData(col, id) {
  init();
  const s = await getDoc(doc(fs, col, id));
  return s.exists() ? s.data() : null;
}
export async function setData(col, id, data, merge = false) { init(); await setDoc(doc(fs, col, id), clean(data), { merge }); }
export async function deleteData(col, id) { init(); await deleteDoc(doc(fs, col, id)); }
// ops: [{ col, id, data }] (data null = delete). Up to 400 per call.
export async function batchWrite(ops) {
  init();
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(fs);
    for (const o of ops.slice(i, i + 400)) { if (o.data) b.set(doc(fs, o.col, o.id), clean(o.data), { merge: !!o.merge }); else b.delete(doc(fs, o.col, o.id)); }
    await b.commit();
  }
}
// Document numbers: one counter per business and year, increased in a transaction so two people never get the same number.
export async function nextNumber(counterId) {
  init();
  return runTransaction(fs, async (t) => {
    const ref = doc(fs, 'counters', counterId);
    const s = await t.get(ref);
    const n = (s.exists() ? Number(s.data().n || 0) : 0) + 1;
    t.set(ref, { n });
    return n;
  });
}
// Live query. filters: [[field, op, value]] — field '__id__' means the document id.
// onChange gets [{ type: 'added'|'modified'|'removed', id, data }].
export function listen(col, filters, onChange, onError) {
  init();
  const parts = filters.map(([f, op, v]) => where(f === '__id__' ? documentId() : f, op, v));
  return onSnapshot(query(collection(fs, col), ...parts), { includeMetadataChanges: false }, (snap) => {
    onChange(snap.docChanges().map(c => ({ type: c.type, id: c.doc.id, data: c.doc.data() })), snap.metadata.fromCache);
  }, (e) => onError && onError(e));
}
