// firebase.js — the ONLY module that talks to the Firebase SDK.
// Everything else imports from here, so the backend can be swapped or mocked.
//
// Firebase web config is public by design (see README). Security is enforced by
// Firebase Authentication + database.rules.json, NOT by hiding these values.
// Fill in `firebaseConfig` with your project's web config from the Firebase Console:
//   Project settings → General → Your apps → SDK setup and configuration.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
    getAuth, signInAnonymously, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
    getDatabase, ref, onValue, get, set, update, remove, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';

const firebaseConfig = {
    apiKey: 'REPLACE_WITH_YOUR_WEB_API_KEY',
    authDomain: 'taku-f8db6.firebaseapp.com',
    databaseURL: 'https://taku-f8db6-default-rtdb.firebaseio.com',
    projectId: 'taku-f8db6',
    // storageBucket / messagingSenderId / appId are optional for this app:
    appId: 'REPLACE_WITH_YOUR_APP_ID',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let currentUid = null;

// Anonymous sign-in gives every visitor a stable, server-issued, unguessable uid.
// Persistence is local, so the same browser keeps the same identity across reloads —
// that is what preserves "you own this event / this response" across sessions.
export const authReady = (async () => {
    try { await setPersistence(auth, browserLocalPersistence); } catch (_) { /* fall back to default */ }
    return new Promise((resolve, reject) => {
        const unsub = onAuthStateChanged(auth, (user) => {
            if (user) { currentUid = user.uid; unsub(); resolve(user.uid); }
        }, reject);
        signInAnonymously(auth).catch(reject);
    });
})();

export function getUid() { return currentUid; }

/* ---------- ref helpers ---------- */
export const eventRef = (id) => ref(db, `events/${id}`);
export const responsesRef = (id) => ref(db, `responses/${id}`);
export const responseRef = (id, rid) => ref(db, `responses/${id}/${rid}`);

/* ---------- connection state (online / offline) ---------- */
export function onConnectionState(cb) {
    return onValue(ref(db, '.info/connected'), (snap) => cb(snap.val() === true));
}

/* ---------- re-exports used by event.js ---------- */
export { onValue, get, set, update, remove, serverTimestamp };
