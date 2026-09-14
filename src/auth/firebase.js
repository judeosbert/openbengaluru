/* Firebase Google sign-in adapter (plan: gate the submit wizard behind
 * Google sign-in). NOT under src/lib — that layer must stay
 * react/leaflet/firebase-free (test/lib-purity.test.js). Singleton init at
 * module import, same pattern as src/data.js. Firebase web config is public
 * by design (hardcoded; no analytics — measurementId unused).
 *
 * Thin API consumed by the store:
 *   signInWithGoogle()  -> Google popup; resolves { uid, displayName, email }
 *   signOutUser()       -> clears the session
 *   listenAuth(cb)      -> firebase onAuthStateChanged subscription;
 *                          returns the unsubscribe function
 *   currentToken()      -> fresh ID token (or null when signed out)
 */
import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged,
} from 'firebase/auth';

initializeApp({
  apiKey: 'AIzaSyCoIyv5kqKoyFngEhO1JlN3vBYhcrBm6IM',
  authDomain: 'umi-banglore.firebaseapp.com',
  projectId: 'umi-banglore',
  storageBucket: 'umi-banglore.firebasestorage.app',
  messagingSenderId: '487017069765',
  appId: '1:487017069765:web:1dcca1cbfa21ac7385c4ac',
});

const auth = getAuth();
const provider = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, provider).then((cred) => ({
    uid: cred.user.uid,
    displayName: cred.displayName,
    email: cred.email,
  }));
}

export function signOutUser() {
  return signOut(auth);
}

export function listenAuth(cb) {
  return onAuthStateChanged(auth, (u) => cb(u && {
    uid: u.uid,
    displayName: u.displayName,
    email: u.email,
  }));
}

export function currentToken() {
  const u = auth.currentUser;
  return u ? u.getIdToken() : Promise.resolve(null);
}
