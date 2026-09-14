/* Email notifications for the review flow (plan: email-notifications).
 * Same layer as db.js/bucket.js/verifyToken.js — NOT src/lib (it needs
 * nodemailer, and src/lib stays DOM-free + framework-free).
 *
 * Contract: SMTP comes from env with NO code defaults — createMailerFromEnv
 * fail-fasts at startup listing missing vars (same as createPoolFromEnv /
 * createS3FromEnv / GOOGLE_APPLICATION_CREDENTIALS). Discrete vars
 * (SIMO_SMTP_HOST/PORT/USER/PASS/FROM, optional SIMO_SMTP_SECURE) or the
 * SIMO_SMTP_URL wholesale override (smtp:// or
 * smtps://user:pass@host:port — then only SIMO_SMTP_FROM is additionally
 * required). SIMO_PUBLIC_BASE_URL (optional) appends a "View:" app-root
 * link to notification emails; it can also be passed as a createMailer
 * option so tests set it directly.
 *
 * Sends are FIRE-AND-FORGET: callers invoke notify() AFTER sendJson; a
 * failed send logs one stdout line and never changes the API response. No
 * retry/queue — a lost send is a log line only.
 */
import nodemailer from 'nodemailer';

export const SMTP_VARS = ['SIMO_SMTP_HOST', 'SIMO_SMTP_PORT',
  'SIMO_SMTP_USER', 'SIMO_SMTP_PASS', 'SIMO_SMTP_FROM'];

/* Transport-level factory — the seam tests inject a fake transport into
 * (mirrors the fetchOsm / netconvertResolver / verifyToken seam style).
 * `from` is fixed at construction; `to` must be a non-empty array (the
 * routes compute recipient lists; a scalar string is a bug, not a recipient). */
export function createMailer(transport, from, baseUrl = null) {
  return {
    baseUrl,
    async send({ to, subject, text }) {
      if (!Array.isArray(to) || to.length === 0) {
        throw new Error('mailer.send requires a non-empty to array');
      }
      return transport.sendMail({ from, to, subject, text });
    },
  };
}

/* Env factory: SIMO_SMTP_URL overrides HOST/PORT/USER/PASS wholesale
 * (FROM still required — the From identity is ours either way). secure
 * defaults to true only for the implicit-TLS port 465; SIMO_SMTP_SECURE
 * ('true'/'false') overrides. opts.createTransport swaps nodemailer's
 * factory in tests; opts.baseUrl overrides SIMO_PUBLIC_BASE_URL. */
export function createMailerFromEnv(env = process.env, opts = {}) {
  const createTransport = opts.createTransport || nodemailer.createTransport;
  const baseUrl = opts.baseUrl !== undefined
    ? opts.baseUrl : (env.SIMO_PUBLIC_BASE_URL || null);
  let transport;
  if (env.SIMO_SMTP_URL) {
    const missing = ['SIMO_SMTP_FROM'].filter((k) => !env[k]);
    if (missing.length) {
      throw new Error('missing env: ' + missing.join(', ')
        + ' — set SIMO_SMTP_* (see .env.example)');
    }
    transport = createTransport(env.SIMO_SMTP_URL);
  } else {
    const missing = SMTP_VARS.filter((k) => !env[k]);
    if (missing.length) {
      throw new Error('missing env: ' + missing.join(', ')
        + ' — set SIMO_SMTP_* (see .env.example)');
    }
    const secure = env.SIMO_SMTP_SECURE != null
      ? env.SIMO_SMTP_SECURE === 'true' : env.SIMO_SMTP_PORT === '465';
    transport = createTransport({
      host: env.SIMO_SMTP_HOST,
      port: Number(env.SIMO_SMTP_PORT),
      secure,
      auth: { user: env.SIMO_SMTP_USER, pass: env.SIMO_SMTP_PASS },
    });
  }
  return createMailer(transport, env.SIMO_SMTP_FROM, baseUrl);
}

/* ---------------------------------------------------------- builders --- */
/* Pure { subject, text } composers (no nodemailer involved). Plain text
 * only: event line, sim id + title, comment/author detail where relevant,
 * a View line only when baseUrl is set. The server routes feed these from
 * the sims row (id/title) and mailer.baseUrl. */

function viewLine(baseUrl) {
  return baseUrl ? '\n\nView: ' + baseUrl : '';
}

export function buildCommentEmail({ sim, comment, byAdmin, baseUrl }) {
  const who = byAdmin ? 'An admin' : 'The sim author';
  return {
    subject: '[OpenBengaluru] New comment on "' + sim.title + '"',
    text: who + ' posted a new comment on a review submission.\n\n'
      + 'Sim: ' + sim.title + ' (' + sim.id + ')\n\n'
      + 'Comment:\n' + comment + viewLine(baseUrl),
  };
}

export function buildRejectedEmail({ sim, comment, baseUrl }) {
  return {
    subject: '[OpenBengaluru] "' + sim.title + '" was rejected',
    text: 'Your simulation "' + sim.title + '" (' + sim.id + ') was '
      + 'rejected by a reviewer and stays out of the public catalog.\n\n'
      + 'Reviewer comment:\n' + comment + viewLine(baseUrl),
  };
}

export function buildSupersededEmail({ sim, by, baseUrl }) {
  return {
    subject: '[OpenBengaluru] "' + sim.title + '" was superseded',
    text: 'Your simulation "' + sim.title + '" (' + sim.id + ') was '
      + 'superseded by a newer submission and is no longer active.\n\n'
      + 'New simulation: "' + by.title + '" (' + by.id + ')'
      + viewLine(baseUrl),
  };
}
