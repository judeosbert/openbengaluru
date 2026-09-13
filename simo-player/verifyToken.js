/* Default verifyToken backend for server.js (Firebase Google sign-in plan).
 * Initializes firebase-admin from GOOGLE_APPLICATION_CREDENTIALS — the same
 * fail-fast missing-env shape as db.js / bucket.js constructors. Exposed as
 * a module (not inline in server.js) so the verifier is inspectable and the
 * server keeps one seam pattern: createSimServer({ verifyToken }) swaps the
 * whole backend; tests never hit Firebase.
 *
 * verifyToken(idToken) -> Promise<claims> on success; throws on
 * missing/invalid/expired tokens. The server maps any failure to
 * 401 { error: 'authentication failed' } — the raw SDK error text never
 * leaks into the response.
 */
import { createRequire } from 'node:module';

export const GOOGLE_CREDENTIALS_VAR = 'GOOGLE_APPLICATION_CREDENTIALS';

/* firebase-admin is CJS; createRequire keeps the ESM import clean. */
const require = createRequire(import.meta.url);

/* Verifies GOOGLE_APPLICATION_CREDENTIALS is set (no default, mirroring
 * the PG-vars / SIMO_S3-vars fail-fast contract) and builds the admin app. Called
 * lazily by createVerifyIdTokenFromEnv so importing server.js never needs
 * the env; `npm start` does. */
export function createVerifyIdTokenFromEnv(env = process.env) {
  const missing = [GOOGLE_CREDENTIALS_VAR].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error('missing env: ' + missing.join(', ')
      + ' — point ' + GOOGLE_CREDENTIALS_VAR + ' at a Firebase service '
      + 'account JSON (see .env.example)');
  }
  /* require (not import) so the dependency stays lazy and CJS interop is
   * explicit; the admin SDK reads GOOGLE_APPLICATION_CREDENTIALS itself. */
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }
  const auth = admin.auth();
  return (idToken) => auth.verifyIdToken(idToken, true);
}
