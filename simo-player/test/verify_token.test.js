/* Contract for verifyToken.js credential handling: GOOGLE_APPLICATION_CREDENTIALS
 * carries the base64 of a Firebase service-account JSON (NOT a file path) so the
 * credential never depends on a filesystem location. The factory decodes +
 * parses the value itself and hands the object to admin.credential.cert().
 *
 * firebase-admin IS exercised here — initializeApp with a cert credential is
 * offline (the PEM is parsed eagerly, so the test uses a generated throwaway
 * key); verifyIdToken is only reached in production, where endpoint tests
 * inject fake verifyToken seams and never hit Firebase.
 */
import { describe, it, expect, afterAll } from 'vitest';
import admin from 'firebase-admin';
import { generateKeyPairSync } from 'node:crypto';
import {
  createVerifyIdTokenFromEnv,
  GOOGLE_CREDENTIALS_VAR,
  serviceAccountFromBase64,
} from '../verifyToken.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'simo-test-project',
  private_key_id: 'testkeyid',
  private_key: PEM,
  client_email: 'firebase-adminsdk@simo-test-project.iam.gserviceaccount.com',
  client_id: '1234567890',
};
const SERVICE_ACCOUNT_B64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT), 'utf8')
  .toString('base64');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe('serviceAccountFromBase64', () => {
  it('decodes base64 service-account JSON into the object', () => {
    expect(serviceAccountFromBase64(SERVICE_ACCOUNT_B64)).toEqual(SERVICE_ACCOUNT);
  });

  it('rejects a value that does not decode to JSON (e.g. a file path)', () => {
    expect(() => serviceAccountFromBase64('/tmp/service-account.json'))
      .toThrow(GOOGLE_CREDENTIALS_VAR);
  });

  it('rejects JSON that is not an object', () => {
    expect(() => serviceAccountFromBase64(b64('123')))
      .toThrow(/service account/);
  });
});

describe('createVerifyIdTokenFromEnv', () => {
  it('fails fast listing the var when unset', () => {
    expect(() => createVerifyIdTokenFromEnv({}))
      .toThrow(/missing env.*GOOGLE_APPLICATION_CREDENTIALS.*base64/s);
  });

  it('builds the admin app from the decoded service account', () => {
    const verifyToken = createVerifyIdTokenFromEnv({
      [GOOGLE_CREDENTIALS_VAR]: SERVICE_ACCOUNT_B64,
    });
    expect(typeof verifyToken).toBe('function');
    expect(admin.apps.length).toBe(1);
    const cred = admin.app().options.credential;
    expect(cred.projectId).toBe('simo-test-project');
    expect(cred.clientEmail).toBe(
      'firebase-adminsdk@simo-test-project.iam.gserviceaccount.com');
  });

  it('rejects a path-like value without creating a second app', () => {
    expect(() => createVerifyIdTokenFromEnv({
      [GOOGLE_CREDENTIALS_VAR]: '/tmp/service-account.json',
    })).toThrow(/base64/);
    expect(admin.apps.length).toBe(1);
  });
});
