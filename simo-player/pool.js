/* In-process worker pool + async process runner (plan: area export +
 * worker pool, phase 1).
 *
 * createPool({ workers, queueMax }) — a FIFO slot pool over async jobs:
 * `workers` jobs run concurrently; accepted jobs beyond that queue up to
 * `queueMax`; a submit beyond the cap throws PoolBusyError (code
 * 'POOL_BUSY') so the caller can answer 503 instead of holding the socket
 * open. Pure promises — no timers, no subprocesses inside the pool.
 *
 * runProcess(cmd, args, { timeoutMs, env }) — the async spawn wrapper that
 * replaced the server's spawnSync: resolves { status, signal, stdout,
 * stderr } (never throws for nonzero exits); kills the child with SIGTERM
 * after timeoutMs and reports signal: 'SIGTERM' in the result.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

export class PoolBusyError extends Error {
  constructor(message = 'worker queue full') {
    super(message);
    this.name = 'PoolBusyError';
    this.code = 'POOL_BUSY';
  }
}

export function createPool({ workers, queueMax = 32 } = {}) {
  const slots = Math.max(1,
    Number(workers) || Math.max(1, os.cpus().length - 1));
  const cap = Math.max(0, Number(queueMax) || 0);
  const queue = [];
  let running = 0;
  let closed = false;
  let onDrained = null;

  function stats() {
    return { workers: slots, running, queued: queue.length };
  }

  function maybeDrained() {
    if (onDrained && running === 0 && queue.length === 0) {
      const cb = onDrained;
      onDrained = null;
      cb();
    }
  }

  function startNext() {
    while (running < slots && queue.length > 0) {
      const item = queue.shift();
      running++;
      Promise.resolve()
        .then(item.fn)
        .finally(() => {
          running--;
          startNext();
          maybeDrained();
        })
        .then(item.resolve, item.reject);
    }
  }

  function submit(fn) {
    if (closed) {
      throw new PoolBusyError('pool is closed');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('job must be a function');
    }
    if (queue.length >= cap) {
      throw new PoolBusyError();
    }
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      startNext();
    });
  }

  function close() {
    closed = true;
    return new Promise((resolve) => {
      if (running === 0 && queue.length === 0) return resolve();
      onDrained = resolve;
    });
  }

  return { submit, stats, close };
}

export function runProcess(cmd, args = [], { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, env ? { env } : undefined);
    let stdout = '';
    let stderr = '';
    let status = null;
    let signal = null;
    let done = false;
    let timedOut = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      /* spawn failure (ENOENT etc.) — mirror spawnSync's null status with
       * the message in stderr; 'close' may never fire */
      status = -1;
      stderr += String((e && e.message) || e) + '\n';
      finish();
    });
    child.on('close', (code, sig) => {
      status = code;
      signal = timedOut ? 'SIGTERM' : sig;
      finish();
    });

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        /* last resort if the child ignores SIGTERM (the result still
         * reports SIGTERM, matching spawnSync's timeout contract) */
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, Math.min(5000, timeoutMs)).unref();
      }, timeoutMs);
      timer.unref?.();
    }
  });
}
