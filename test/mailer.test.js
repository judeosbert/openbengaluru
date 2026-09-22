/* mailer.js unit tests — SMTP env fail-fast (same contract as
 * createS3FromEnv: no code defaults, missing vars listed), the
 * SIMO_SMTP_URL wholesale override (FROM still required), the secure
 * default (465 -> true, else false), the { send, baseUrl } seam over a
 * fake transport (no real SMTP, mirrors the fetchOsm/verifyToken seam
 * precedent), and the three pure notification builders. Plan:
 * email-notifications.
 */
import { it, expect } from 'vitest';
import {
  SMTP_VARS, createMailer, createMailerFromEnv,
  buildCommentEmail, buildRejectedEmail, buildSupersededEmail,
  buildCaptureRejectedEmail,
} from '../mailer.js';

/* ------------------------------------------------------------- constants --- */

it('SMTP_VARS carries the discrete SIMO_SMTP_* contract', () => {
  expect(SMTP_VARS).toEqual([
    'SIMO_SMTP_HOST', 'SIMO_SMTP_PORT', 'SIMO_SMTP_USER', 'SIMO_SMTP_PASS',
    'SIMO_SMTP_FROM',
  ]);
});

/* ---------------------------------------------------------- env factory --- */

const SMTP_KEYS = [...SMTP_VARS, 'SIMO_SMTP_URL', 'SIMO_SMTP_SECURE',
  'SIMO_PUBLIC_BASE_URL'];

function withEnv(over, fn) {
  const saved = SMTP_KEYS.map((k) => [k, process.env[k]]);
  try {
    for (const k of SMTP_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];   // NOT "undefined"
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FULL_SMTP_ENV = {
  SIMO_SMTP_HOST: 'smtp.x.test',
  SIMO_SMTP_PORT: '587',
  SIMO_SMTP_USER: 'mailer',
  SIMO_SMTP_PASS: 'secret',
  SIMO_SMTP_FROM: 'no-reply@x.test',
};

/* Fake createTransport seam: records the config nodemailer would receive
 * and hands back a recording transport. */
function fakeTransportFactory() {
  const transport = { mails: [], async sendMail(mail) {
    transport.mails.push(mail);
    return { accepted: mail.to };
  } };
  const calls = [];
  const factory = (config) => { calls.push(config); return transport; };
  factory.calls = calls;
  factory.transport = transport;
  return factory;
}

function failMessage(fn) {
  try {
    fn();
  } catch (e) {
    return String((e && e.message) || e);
  }
  return null;
}

/* ------------------------------------------------------- fail fast (env) --- */

it('createMailerFromEnv fails fast listing every missing discrete var', () => {
  withEnv({}, () => {
    const msg = failMessage(() => createMailerFromEnv());
    expect(msg, 'must throw on missing env').toBeTruthy();
    for (const k of SMTP_VARS) expect(msg).toContain(k);
  });
});

it('createMailerFromEnv fails fast on a missing FROM even with the rest set', () => {
  withEnv({ ...FULL_SMTP_ENV, SIMO_SMTP_FROM: undefined }, () => {
    const msg = failMessage(() => createMailerFromEnv());
    expect(msg).toBeTruthy();
    expect(msg).toContain('SIMO_SMTP_FROM');
    expect(msg).not.toContain('SIMO_SMTP_HOST');
  });
});

it('SIMO_SMTP_URL overrides HOST/PORT/USER/PASS wholesale — only FROM required', () => {
  withEnv({ SIMO_SMTP_URL: 'smtp://u:p@smtp.x.test:587',
    SIMO_SMTP_FROM: 'no-reply@x.test' }, () => {
    const ct = fakeTransportFactory();
    const mailer = createMailerFromEnv(process.env, { createTransport: ct });
    expect(ct.calls).toEqual(['smtp://u:p@smtp.x.test:587']);
    expect(typeof mailer.send).toBe('function');
  });
});

it('SIMO_SMTP_URL still requires SIMO_SMTP_FROM (fail-fast lists it)', () => {
  withEnv({ SIMO_SMTP_URL: 'smtp://u:p@smtp.x.test:587' }, () => {
    const msg = failMessage(() => createMailerFromEnv());
    expect(msg).toBeTruthy();
    expect(msg).toContain('SIMO_SMTP_FROM');
  });
});

/* ------------------------------------------------- discrete transport opts --- */

it('discrete env builds the nodemailer config; port 587 defaults secure=false', () => {
  withEnv(FULL_SMTP_ENV, () => {
    const ct = fakeTransportFactory();
    createMailerFromEnv(process.env, { createTransport: ct });
    expect(ct.calls).toEqual([{
      host: 'smtp.x.test',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: 'secret' },
    }]);
  });
});

it('port 465 defaults secure=true; SIMO_SMTP_SECURE overrides either way', () => {
  withEnv({ ...FULL_SMTP_ENV, SIMO_SMTP_PORT: '465' }, () => {
    const ct = fakeTransportFactory();
    createMailerFromEnv(process.env, { createTransport: ct });
    expect(ct.calls[0].secure).toBe(true);
  });
  withEnv({ ...FULL_SMTP_ENV, SIMO_SMTP_SECURE: 'true' }, () => {
    const ct = fakeTransportFactory();
    createMailerFromEnv(process.env, { createTransport: ct });
    expect(ct.calls[0].secure).toBe(true);
  });
  withEnv({ ...FULL_SMTP_ENV, SIMO_SMTP_PORT: '465',
    SIMO_SMTP_SECURE: 'false' }, () => {
    const ct = fakeTransportFactory();
    createMailerFromEnv(process.env, { createTransport: ct });
    expect(ct.calls[0].secure).toBe(false);
  });
});

/* ----------------------------------------------------- baseUrl + send seam --- */

it('baseUrl comes from SIMO_PUBLIC_BASE_URL, the opts override wins, default null', () => {
  withEnv(FULL_SMTP_ENV, () => {
    const ct = fakeTransportFactory();
    expect(createMailerFromEnv(process.env,
      { createTransport: ct }).baseUrl).toBeNull();
  });
  withEnv({ ...FULL_SMTP_ENV, SIMO_PUBLIC_BASE_URL: 'https://env.test' }, () => {
    const ct = fakeTransportFactory();
    const m = createMailerFromEnv(process.env, { createTransport: ct });
    expect(m.baseUrl).toBe('https://env.test');
    const m2 = createMailerFromEnv(process.env,
      { createTransport: ct, baseUrl: 'https://opt.test' });
    expect(m2.baseUrl).toBe('https://opt.test');
  });
});

it('createMailer sends { from, to, subject, text } through the transport', async () => {
  const ct = fakeTransportFactory();
  const mailer = createMailer(ct.transport, 'no-reply@x.test');
  await mailer.send({ to: ['a@x.test', 'b@x.test'], subject: 's',
    text: 'hello' });
  expect(ct.transport.mails).toEqual([{
    from: 'no-reply@x.test',
    to: ['a@x.test', 'b@x.test'],
    subject: 's',
    text: 'hello',
  }]);
});

it('createMailer.send requires a non-empty to array', async () => {
  const transport = { sendMail: async () => ({}) };
  const mailer = createMailer(transport, 'no-reply@x.test');
  await expect(mailer.send({})).rejects.toThrow(/to/);
  await expect(mailer.send({ to: [] })).rejects.toThrow(/to/);
  await expect(mailer.send({ to: 'a@x.test' })).rejects.toThrow(/to/);
});

/* --------------------------------------------------------------- builders --- */

const SIM = { id: 'sim-1', title: 'My sim' };

it('buildCommentEmail: subject pins the title, body carries id + comment', () => {
  const mail = buildCommentEmail({ sim: SIM, comment: 'looks off',
    byAdmin: false });
  expect(Object.keys(mail).sort()).toEqual(['subject', 'text']);
  expect(mail.subject).toBe('[OpenBengaluru] New comment on "My sim"');
  expect(mail.text).toContain('sim-1');
  expect(mail.text).toContain('My sim');
  expect(mail.text).toContain('looks off');
  expect(mail.text).not.toContain('View:');
});

it('buildCommentEmail: admin flag + baseUrl append a View line', () => {
  const mail = buildCommentEmail({ sim: SIM, comment: 'approved shape',
    byAdmin: true, baseUrl: 'https://app.test' });
  expect(mail.text).toMatch(/admin/i);
  expect(mail.text).toContain('approved shape');
  expect(mail.text).toContain('View: https://app.test');
});

it('buildRejectedEmail: subject pins the title, body carries the comment', () => {
  const mail = buildRejectedEmail({ sim: SIM, comment: 'fix the numbers',
    baseUrl: null });
  expect(mail.subject).toBe('[OpenBengaluru] "My sim" was rejected');
  expect(mail.text).toContain('sim-1');
  expect(mail.text).toContain('fix the numbers');
  expect(mail.text).not.toContain('View:');
});

it('buildSupersededEmail: subject pins the OLD title, body names the new sim', () => {
  const mail = buildSupersededEmail({ sim: SIM, by: { id: 'sim-2',
    title: 'New sim' }, baseUrl: 'https://app.test' });
  expect(mail.subject).toBe('[OpenBengaluru] "My sim" was superseded');
  expect(mail.text).toContain('sim-1');
  expect(mail.text).toContain('sim-2');
  expect(mail.text).toContain('New sim');
  expect(mail.text).toContain('View: https://app.test');
});

it('buildCaptureRejectedEmail: subject pins the junction, body carries the '
  + 'reason verbatim', () => {
  const capture = { id: 'cap-1', junction: 'Silk Board Junction',
    method: 'snapshot', captured_at: '2026-01-02T03:04:05.000Z' };
  const mail = buildCaptureRejectedEmail({
    capture, reason: 'not a real junction',
    baseUrl: null });
  expect(Object.keys(mail).sort()).toEqual(['subject', 'text']);
  expect(mail.subject)
    .toBe('[OpenBengaluru] Your capture at "Silk Board Junction" was removed');
  expect(mail.text).toContain('Silk Board Junction');
  expect(mail.text).toContain('snapshot');
  expect(mail.text).toContain('2026-01-02');
  expect(mail.text).toContain('not a real junction');
  expect(mail.text).not.toContain('View:');
});

it('buildCaptureRejectedEmail: baseUrl appends a View line', () => {
  const mail = buildCaptureRejectedEmail({
    capture: { id: 'cap-1', junction: 'A', method: 'snapshot',
      captured_at: null },
    reason: 'blurry', baseUrl: 'https://app.test' });
  expect(mail.text).toContain('View: https://app.test');
});
