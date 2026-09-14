/* Default verifyToken backend for server.js (Firebase Google sign-in plan).
 * Initializes firebase-admin from GOOGLE_APPLICATION_CREDENTIALS — the same
 * fail-fast missing-env shape as db.js / bucket.js constructors. The var
 * carries the base64 of a Firebase service-account JSON (not a file path),
 * decoded by serviceAccountFromBase64 and passed to admin.credential.cert().
 * Exposed as a module (not inline in server.js) so the verifier is
 * inspectable and the server keeps one seam pattern:
 * createSimServer({ verifyToken }) swaps the whole backend; tests never hit
 * Firebase.
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

/* Decodes a base64 service-account JSON value into the object cert() wants.
 * Throws a clear error naming the var for values that do not decode to a
 * JSON object (file paths, truncated blobs, junk) — fail-fast, mirroring the
 * PG-vars / SIMO_S3-vars contract. */
export function serviceAccountFromBase64(value) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new Error(GOOGLE_CREDENTIALS_VAR + ' must be the base64 of a '
      + 'Firebase service account JSON (see .env.example) — the value does '
      + 'not decode to JSON');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(GOOGLE_CREDENTIALS_VAR + ' must be the base64 of a '
      + 'Firebase service account JSON (see .env.example) — the value '
      + 'decodes to ' + typeof decoded);
  }
  return decoded;
}

/* Verifies GOOGLE_APPLICATION_CREDENTIALS is set (no default, mirroring
 * the PG-vars / SIMO_S3-vars fail-fast contract) and builds the admin app.
 * Called lazily by createVerifyIdTokenFromEnv so importing server.js never needs
 * the env; `npm start` does. */
export function createVerifyIdTokenFromEnv(env = process.env) {
  const missing = [GOOGLE_CREDENTIALS_VAR].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error('missing env: ' + missing.join(', ')
      + ' — set ' + GOOGLE_CREDENTIALS_VAR + ' to the base64 of a Firebase '
      + 'service account JSON (see .env.example)');
  }
  const serviceAccount = serviceAccountFromBase64(env[GOOGLE_CREDENTIALS_VAR]);
  /* require (not import) so the dependency stays lazy and CJS interop is
   * explicit; the service-account object (not a path) feeds cert(). */
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
  const auth = admin.auth();
  return (idToken) => auth.verifyIdToken(idToken, true);
}
