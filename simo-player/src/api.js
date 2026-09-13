/* Review-flow API wrappers for the client (plan: review flow + dashboards).
 * Lives in src/ — NOT src/lib (src/lib must stay DOM-free; this module is
 * the fetch twin of src/auth/firebase.js's placement).
 *
 * Every authed call pulls the Firebase ID token via currentToken() itself
 * (token-explicit wrappers — components never touch tokens). Failures throw
 * an Error carrying the server's body.error text (or 'HTTP <status>') so
 * callers can toast honestly. The public catalog calls need no token.
 */
import { currentToken } from './auth/firebase.js';

async function call(path, { method = 'GET', body, authed = true } = {}) {
  const headers = {};
  if (authed) {
    const token = await currentToken();
    if (!token) throw new Error('not signed in');
    headers.Authorization = 'Bearer ' + token;
  }
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'HTTP ' + res.status);
  }
  return res.json();
}

/* Role discovery for the dashboards: { author, email, uid, isAdmin }. */
export function fetchMe() {
  return call('/api/me');
}

/* The active submissions half of the catalog (public, no token). */
export function fetchCatalog() {
  return call('/api/catalog', { authed: false });
}

/* Lazy-stream payload for an API-catalog entry (public, active only). */
export function fetchCatalogStream(id) {
  return call('/api/catalog/' + encodeURIComponent(id) + '/stream',
    { authed: false });
}

/* Dashboard lists. Admins get everything, users their own (server-decided
 * by the token). status filters to one review state. */
export function fetchSubmissions(status) {
  const q = status ? '?status=' + encodeURIComponent(status) : '';
  return call('/api/submissions' + q);
}

/* Detail bundle: { submission, files, comments }. */
export function fetchSubmission(id) {
  return call('/api/submissions/' + encodeURIComponent(id));
}

/* Playable preview of a non-active submission: { entry, stream }. */
export function fetchPreview(id) {
  return call('/api/submissions/' + encodeURIComponent(id) + '/preview');
}

export function postComment(id, body) {
  return call('/api/submissions/' + encodeURIComponent(id) + '/comments',
    { method: 'POST', body: { body } });
}

export function activate(id, supersedes) {
  return call('/api/submissions/' + encodeURIComponent(id) + '/activate',
    { method: 'POST', body: supersedes ? { supersedes } : {} });
}

export function reject(id, comment) {
  return call('/api/submissions/' + encodeURIComponent(id) + '/reject',
    { method: 'POST', body: { comment } });
}

export function deactivate(id) {
  return call('/api/submissions/' + encodeURIComponent(id) + '/deactivate',
    { method: 'POST', body: {} });
}

/* Server-side area export: POST /api/export-net -> the finished .net.xml
 * as a Blob. Binary response, so it bypasses the JSON `call` helper but
 * keeps the same auth + error-text contract. */
export async function exportNet(bbox, { name, zoom } = {}) {
  const token = await currentToken();
  if (!token) throw new Error('sign in to export');
  let res;
  try {
    res = await fetch('/api/export-net', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ bbox, name, zoom }),
    });
  } catch (e) {
    throw new Error('export needs the player server (npm start) — '
      + 'fetch failed: ' + (e && e.message));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'HTTP ' + res.status);
  }
  return res.blob();
}

/* Stored-source re-download for the resubmit prefill (owner token). */
export function fetchFileList(id) {
  return call('/api/files/' + encodeURIComponent(id));
}

export function fetchFileText(id, name) {
  return call('/api/files/' + encodeURIComponent(id) + '/'
    + encodeURIComponent(name));
}
