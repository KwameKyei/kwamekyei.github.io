// Good Points: online family sync (Firebase).
// The app works fully offline without this file; when a parent signs in and
// joins a family, this keeps every parent's phone in sync.

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCW6RVUGB19lUPsMYx8M2aRCFUgh4tmKmA",
  authDomain: "good-points-d5e28.firebaseapp.com",
  projectId: "good-points-d5e28",
  storageBucket: "good-points-d5e28.firebasestorage.app",
  messagingSenderId: "1075348186219",
  appId: "1:1075348186219:web:40a507b8e84c012381fd2e"
};
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const LS_FAMILY = 'goodPoints.familyId';
const LS_SYNCED = 'goodPoints.syncedFamily';
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const GP = window.GP;
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
};
function setStatus(patch) { Object.assign(GP.sync, patch); GP.render(); }

let A, F, auth, db, user = null;
let fid = null, unsubs = [], famReady = false, logReady = false;
let lastMetaJson = null, lastLogIds = new Set();

const metaOf = S => ({ kids: S.kids, behaviors: S.behaviors, rewards: S.rewards, pin: S.settings.pin || '' });
const famRef = id => F.doc(db, 'families', id);
const logCol = id => F.collection(db, 'families', id, 'log');
const pretty = c => c.slice(0, 4) + '-' + c.slice(4);
function newCode() {
  const r = crypto.getRandomValues(new Uint32Array(8));
  return Array.from(r, n => CODE_ABC[n % CODE_ABC.length]).join('');
}
function friendly(e) {
  const c = (e && e.code) || '';
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return 'Sign-in was cancelled.';
  if (c.includes('network') || c.includes('unavailable')) return 'No internet connection. Try again when you\'re online.';
  if (c.includes('permission-denied')) return 'Permission denied. Check the code, or ask the other parent to check the database rules.';
  if (c.includes('unauthorized-domain')) return 'This website isn\'t allowed to sign in yet. Add it under Firebase → Authentication → Settings → Authorized domains.';
  return (e && e.message) || 'Something went wrong.';
}

// Run Firestore writes in chunks (a batch holds at most 500 changes).
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = F.writeBatch(db);
    ops.slice(i, i + 450).forEach(op => op(b));
    await b.commit();
  }
}

// ---------- push local changes up ----------
function push() {
  if (!fid || !famReady || !logReady) return;
  const S = GP.state, ops = [];
  const meta = metaOf(S), mj = JSON.stringify(meta);
  if (mj !== lastMetaJson) { lastMetaJson = mj; const ref = famRef(fid); ops.push(b => b.set(ref, meta, { merge: true })); }
  const cur = new Map(S.log.map(e => [e.id, e]));
  for (const [id, e] of cur) if (!lastLogIds.has(id)) { lastLogIds.add(id); const ref = F.doc(logCol(fid), id); ops.push(b => b.set(ref, e)); }
  for (const id of [...lastLogIds]) if (!cur.has(id)) { lastLogIds.delete(id); const ref = F.doc(logCol(fid), id); ops.push(b => b.delete(ref)); }
  if (ops.length) commitOps(ops).catch(e => { console.error(e); GP.toast('Couldn\'t sync: ' + friendly(e)); });
}

// ---------- listen for changes from other phones ----------
function stopListening() { unsubs.forEach(u => u()); unsubs = []; fid = null; famReady = logReady = false; lastMetaJson = null; lastLogIds = new Set(); }

function listen(familyId) {
  stopListening();
  fid = familyId; ls.set(LS_FAMILY, fid);
  const trusted = snap => !snap.metadata.fromCache || ls.get(LS_SYNCED) === familyId;
  const markReady = () => { if (famReady && logReady) { ls.set(LS_SYNCED, familyId); setStatus({ status: 'on' }); } };

  unsubs.push(F.onSnapshot(famRef(familyId), { includeMetadataChanges: false }, snap => {
    if (!snap.exists()) { if (!snap.metadata.fromCache) leaveLocal('This family no longer exists.'); return; }
    if (!trusted(snap)) return;
    const d = snap.data();
    GP.apply(S => { S.kids = d.kids || []; S.behaviors = d.behaviors || []; S.rewards = d.rewards || []; S.settings.pin = d.pin || ''; });
    lastMetaJson = JSON.stringify(metaOf(GP.state));
    GP.sync.code = d.code ? pretty(d.code) : '';
    GP.sync.members = (d.members || []).length;
    famReady = true; markReady(); GP.render();
  }, err => { console.error(err); if (err.code === 'permission-denied') leaveLocal('You no longer have access to this family.'); else setStatus({ status: 'error', error: friendly(err) }); }));

  unsubs.push(F.onSnapshot(logCol(familyId), snap => {
    if (!trusted(snap)) return;
    const log = snap.docs.map(d => d.data()).sort((a, b) => a.ts - b.ts);
    lastLogIds = new Set(log.map(e => e.id));
    GP.apply(S => { S.log = log; });
    logReady = true; markReady();
  }, err => console.error(err)));
}

function leaveLocal(msg) {
  stopListening(); ls.set(LS_FAMILY, null); ls.set(LS_SYNCED, null);
  setStatus({ status: user ? 'no-family' : 'signed-out', code: '', members: 0 });
  if (msg) GP.toast(msg);
}

// ---------- actions called from the Settings screen ----------
const actions = {
  async signIn() {
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try { await A.signInWithPopup(auth, provider); }
    catch (e) {
      if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code || '')) return A.signInWithRedirect(auth, provider);
      GP.toast(friendly(e));
    }
  },
  async signOut() {
    leaveLocal(); await A.signOut(auth);
    GP.toast('Signed out. Points on this phone are no longer shared.');
  },
  async createFamily() {
    if (!user) return;
    setStatus({ status: 'working' });
    try {
      const S = GP.state, ref = F.doc(F.collection(db, 'families'));
      let code = newCode();
      for (let i = 0; i < 5 && (await F.getDoc(F.doc(db, 'invites', code))).exists(); i++) code = newCode();
      await commitOps([b => {
        b.set(ref, { members: [user.uid], owner: user.uid, code, createdAt: F.serverTimestamp(), ...metaOf(S) });
        b.set(F.doc(db, 'invites', code), { familyId: ref.id });
        b.set(F.doc(db, 'users', user.uid), { familyId: ref.id });
      }]);
      await commitOps(S.log.map(e => b => b.set(F.doc(logCol(ref.id), e.id), e)));
      ls.set(LS_SYNCED, ref.id);
      listen(ref.id);
      GP.toast('Family created! Share the invite code with the other parent.');
    } catch (e) { console.error(e); setStatus({ status: 'no-family' }); GP.toast(friendly(e)); }
  },
  async joinFamily(input) {
    if (!user) return;
    const code = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) return GP.toast('Invite codes look like ABCD-2345.');
    setStatus({ status: 'working' });
    try {
      const inv = await F.getDoc(F.doc(db, 'invites', code));
      if (!inv.exists()) { setStatus({ status: 'no-family' }); return GP.toast('No family found with that code.'); }
      const familyId = inv.data().familyId;
      await F.updateDoc(famRef(familyId), { members: F.arrayUnion(user.uid), joinWith: code });
      await F.setDoc(F.doc(db, 'users', user.uid), { familyId });
      ls.set(LS_SYNCED, null);
      listen(familyId);
      GP.toast('Joined! This phone now shares points with your family.');
    } catch (e) { console.error(e); setStatus({ status: 'no-family' }); GP.toast(friendly(e)); }
  },
  async shareCode() {
    const code = GP.sync.code; if (!code) return;
    const text = `Join our family on Good Points: open ${location.origin + location.pathname}, go to ⚙️ Settings → Family sync, sign in, and enter code ${code}`;
    try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); GP.toast('Invite copied. Paste it in a message.'); } } catch (e) {}
  }
};

// ---------- start ----------
async function start() {
  try {
    const { initializeApp } = await import(`${SDK}/firebase-app.js`);
    A = await import(`${SDK}/firebase-auth.js`);
    F = await import(`${SDK}/firebase-firestore.js`);
    const app = initializeApp(FIREBASE_CONFIG);
    auth = A.getAuth(app);
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }), ignoreUndefinedProperties: true });
    if (window.GP_EMULATOR) {  // used only for local testing
      A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      window.__gpTest = { auth, A, F, db };
    }
  } catch (e) {
    console.warn('Online sync unavailable', e);
    return setStatus({ status: 'unavailable' });
  }
  GP.sync.actions = actions;
  GP.onSave = push;
  A.getRedirectResult(auth).catch(e => GP.toast(friendly(e)));

  A.onAuthStateChanged(auth, async u => {
    user = u;
    if (!u) { stopListening(); return setStatus({ status: 'signed-out', user: '', code: '' }); }
    GP.sync.user = u.displayName || u.email || 'Parent';
    let familyId = ls.get(LS_FAMILY);
    try {
      const snap = await F.getDoc(F.doc(db, 'users', u.uid));
      familyId = snap.exists() ? snap.data().familyId : null;
    } catch (e) { /* offline: use the family remembered on this phone */ }
    if (familyId) { setStatus({ status: 'connecting' }); listen(familyId); }
    else setStatus({ status: 'no-family' });
  });
}
start();
