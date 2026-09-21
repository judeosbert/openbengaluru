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

/* Server-side area export: POST /api/export-net -> ONE .zip holding the
 * finished .net.xml + the fetched .osm.xml, as a Blob. Binary response,
 * so it bypasses the JSON `call` helper but keeps the same auth +
 * error-text contract. */
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

/* Capture upload (plan: capture-leaderboard page): the RAW file bytes ride
 * as the request body — no multipart parser — and the metadata rides as
 * URI-encoded query params. The file's MIME type is the Content-Type (the
 * server accepts video/*|image/* only). meta keys map 1:1 to query params:
 * junction, method, capturedAt, lat, lng, hash (the client's crypto.subtle
 * short-circuit — the server recomputes anyway). A 409 duplicate comes
 * back as 'already uploaded' through the standard body.error path. */
export async function uploadCapture(file, meta) {
  const token = await currentToken();
  if (!token) throw new Error('sign in to upload');
  const parts = [];
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  let res;
  try {
    res = await fetch('/api/captures?' + parts.join('&'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
  } catch (e) {
    throw new Error('upload needs the player server (npm start) — '
      + 'fetch failed: ' + (e && e.message));
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'HTTP ' + res.status);
  }
  return res.json();
}

/* Public all-time leaderboard: { entries: [{ rank, name, points }] }. */
export function fetchLeaderboard() {
  return call('/api/captures/leaderboard', { authed: false });
}

/* Admin capture moderation (plan: capture-admin-moderation): the
 * AdminView CAPTURES feed and the hard-delete reject (the server requires
 * a non-empty reason and emails it to the uploader). */
export function fetchAdminCaptures() {
  return call('/api/admin/captures');
}

export function rejectCapture(id, reason) {
  return call('/api/admin/captures/' + encodeURIComponent(id) + '/reject',
    { method: 'POST', body: { reason } });
}
