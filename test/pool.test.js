/* pool.js unit tests (plan: area export + worker pool, phase 1) — the
 * in-process slot pool that replaces the simulate mutex + the async
 * runProcess wrapper that replaces the server's spawnSync.
 *
 * Contract under test:
 *   createPool({ workers, queueMax }) -> { submit(fn), stats(), close() }
 *     - FIFO: jobs start in submit order
 *     - never more than `workers` jobs running concurrently
 *     - when `queued >= queueMax`, submit rejects with a PoolBusyError
 *       (err.code === 'POOL_BUSY') — the job is NOT accepted
 *     - a rejecting job does not stall the queue
 *     - close(): in-flight jobs finish, later submits reject
 *     - stats(): { workers, running, queued }
 *   runProcess(cmd, args, { timeoutMs, env }) -> { status, signal, stdout,
 *     stderr } — resolves (never throws) for nonzero exits; kills the child
 *     on timeout with signal: 'SIGTERM'.
 */
import { it, expect } from 'vitest';
import { createPool, runProcess, PoolBusyError } from '../pool.js';

function deferred() {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

it('runs jobs FIFO when a slot frees (single worker)', async () => {
  const p = createPool({ workers: 1, queueMax: 8 });
  const order = [];
  const gate = deferred();
  const jobs = [
    p.submit(async () => { order.push('a-start'); await gate.p; order.push('a-end'); }),
    p.submit(async () => { order.push('b'); }),
    p.submit(async () => { order.push('c'); }),
  ];
  await sleep(20);
  expect(order).toEqual(['a-start']);     // b and c wait for the slot
  gate.resolve();
  await Promise.all(jobs);
  expect(order).toEqual(['a-start', 'a-end', 'b', 'c']);
  const s = p.stats();
  expect(s).toEqual({ workers: 1, running: 0, queued: 0 });
  await p.close();
});

it('never runs more than `workers` jobs concurrently', async () => {
  const p = createPool({ workers: 2, queueMax: 8 });
  let running = 0;
  let max = 0;
  const gates = [];
  const jobs = [];
  for (let i = 0; i < 5; i++) {
    const g = deferred();
    gates.push(g);
    jobs.push(p.submit(async () => {
      running++;
      max = Math.max(max, running);
      await g.p;
      running--;
    }));
  }
  await sleep(20);
  expect(p.stats()).toEqual({ workers: 2, running: 2, queued: 3 });
  for (const g of gates) g.resolve();
  await Promise.all(jobs);
  expect(max, 'max observed concurrency must equal the slot count').toBe(2);
  await p.close();
});

it('rejects the (queueMax+1)th submit with POOL_BUSY without accepting it', async () => {
  const p = createPool({ workers: 1, queueMax: 1 });
  const gate = deferred();
  const first = p.submit(async () => { await gate.p; });   // running
  const second = p.submit(async () => {});                 // queued (1/1)
  let busy = null;
  try {
    p.submit(async () => {});
  } catch (e) {
    busy = e;
  }
  expect(busy, 'submit must reject synchronously when the queue is full')
    .toBeInstanceOf(PoolBusyError);
  expect(busy.code).toBe('POOL_BUSY');
  expect(p.stats().queued).toBe(1);       // the rejected job was not queued
  gate.resolve();
  await first;
  await second;
  await p.close();
});

it('a rejecting job does not stall the queue', async () => {
  const p = createPool({ workers: 1, queueMax: 8 });
  await expect(p.submit(async () => {
    throw new Error('job blew up');
  })).rejects.toThrow('job blew up');
  const done = await p.submit(async () => 'ok');
  expect(done).toBe('ok');
  expect(p.stats().running).toBe(0);
  await p.close();
});

it('close() drains in-flight jobs and rejects new submits', async () => {
  const p = createPool({ workers: 1, queueMax: 4 });
  let finished = false;
  const inflight = p.submit(async () => {
    await sleep(30);
    finished = true;
    return 'drained';
  });
  await p.close();
  expect(await inflight, 'in-flight job completes before close resolves')
    .toBe('drained');
  expect(finished).toBe(true);
  expect(() => p.submit(async () => {}), 'post-close submit rejects')
    .toThrow();
  expect(p.stats().running).toBe(0);
});

it('submit returns the job\'s value and stats() tracks the queue', async () => {
  const p = createPool({ workers: 1, queueMax: 8 });
  const gate = deferred();
  const first = p.submit(async () => { await gate.p; return 1; });
  const second = p.submit(async () => 2);
  expect(p.stats().queued).toBe(1);
  gate.resolve();
  expect(await first).toBe(1);
  expect(await second).toBe(2);
  await p.close();
});

/* -------------------------------------------------------- runProcess --- */

it('runProcess captures stdout, stderr and exit codes without throwing', async () => {
  const out = await runProcess(process.execPath, ['-e',
    'process.stdout.write("hello-out\\n");'
    + 'process.stderr.write("hello-err\\n");'
    + 'process.exitCode = 3;']);
  expect(out.status).toBe(3);
  expect(out.signal).toBeNull();
  expect(out.stdout).toContain('hello-out');
  expect(out.stderr).toContain('hello-err');
});

it('runProcess resolves with signal SIGTERM on timeout (kills the child)', async () => {
  const started = Date.now();
  const out = await runProcess('sleep', ['30'], { timeoutMs: 200 });
  expect(out.signal).toBe('SIGTERM');
  expect(Date.now() - started,
    'must return promptly after the kill, not after sleep finishes')
    .toBeLessThan(5000);
});

it('runProcess resolves status 0 on success', async () => {
  const out = await runProcess(process.execPath, ['-e', 'process.exit(0)']);
  expect(out.status).toBe(0);
  expect(out.signal).toBeNull();
});
