import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createNotification, deliverNotifications, sendEmail } from './notifications.mjs';
import * as data from './data.mjs';
import * as fees from './fees.mjs';
import * as routes from './routes.mjs';

const env = { RESEND_API_KEY: 'private-key', EMAIL_FROM: 'Tracker <sender@example.com>', EMAIL_TO: 'one@example.com, two@example.com' };
test('Resend retries transient failures with the same payload/key and a timeout', async () => {
  const requests = [], waits = [];
  await sendEmail(createNotification('newlow', '## 新低價\n票價 1000'), {
    env, sleep: async ms => waits.push(ms), fetchFn: async (url, init) => {
      requests.push({ url, ...init });
      if (requests.length === 1) throw new Error('network');
      if (requests.length === 2) return { ok: false, status: 429 };
      return { ok: true, json: async () => ({ id: 'accepted' }) };
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.headers['Idempotency-Key'])).size, 1);
  assert.equal(new Set(requests.map(r => r.body)).size, 1);
  assert(requests.every(r => r.signal instanceof AbortSignal));
  assert.deepEqual(JSON.parse(requests[0].body).to, ['one@example.com', 'two@example.com']);
  assert.deepEqual(waits, [1000, 2000]);
});

test('missing secrets, permanent errors and exhausted retries fail without leaking provider data', async () => {
  await assert.rejects(sendEmail({}, { env: {} }), /RESEND_API_KEY.*EMAIL_FROM.*EMAIL_TO/);
  let calls = 0;
  await assert.rejects(sendEmail(createNotification('daily', 'summary'), {
    env, fetchFn: async () => { calls++; return { ok: false, status: 401, text: () => 'private-key' }; },
  }), /^Error: Resend HTTP 401/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(sendEmail(createNotification('daily', 'summary'), {
    env, sleep: async () => {}, fetchFn: async () => { calls++; throw new Error('private-key'); },
  }), /^Error: Resend 網路錯誤/);
  assert.equal(calls, 3);
});

test('each channel retries independently across serialized queue reloads', async () => {
  for (const failed of ['email', 'issue']) {
    let queue = [createNotification('newlow+daily', 'body')], saved;
    const counts = { email: 0, issue: 0 };
    let failing = true;
    const options = {
      save: () => { saved = JSON.stringify(queue); }, log: () => {}, report: () => {},
      ...Object.fromEntries(['email', 'issue'].map(channel => [channel, async () => {
        counts[channel]++;
        if (failing && channel === failed) throw new Error('unavailable');
      }])),
    };
    assert.equal((await deliverNotifications(queue, options)).errors.length, 1);
    queue = JSON.parse(saved);
    assert.equal(queue[0][`${failed}Sent`], false);
    failing = false;
    assert.equal((await deliverNotifications(queue, options)).errors.length, 0);
    assert.equal(queue.length, 0);
    assert.equal(counts[failed], 2);
    assert.equal(counts[failed === 'email' ? 'issue' : 'email'], 1);
  }
});

test('delivery limit preserves backlog without silently dropping messages', async () => {
  const queue = Array.from({ length: 12 }, () => createNotification('change', 'body'));
  await deliverNotifications(queue, { email: async () => {}, issue: async () => {}, save: () => {}, log: () => {} });
  assert.equal(queue.length, 2);
});

// Run the real watch pipeline against an in-memory filesystem and fixed clock.
// No production API, email, Issue or tracked data is touched.
function watcher(args = []) {
  const root = new URL('../', import.meta.url);
  const files = new Map(['tools/state.json', 'status.json', 'all-routes.html',
    'tools/all-routes.template.html', 'tools/index.template.html', 'status_template.html']
    .map(path => [new URL(path, root).href, readFileSync(new URL(path, root), 'utf8')]));
  files.set(new URL('tools/state.json', root).href, '{}');
  files.set(new URL('status.json', root).href, '{"runs":[]}');
  let fare = 2000, failEmail = false, emailCalls = 0, issueCalls = 0, writes = 0;
  const source = readFileSync(new URL('./watch.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('./watch.mjs', import.meta.url).href));
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-28T01:00:00Z'])); }
    static now() { return new Date('2026-10-28T01:00:00Z').getTime(); }
  }
  const proc = { argv: ['node', 'watch', '--fixture=fixture.json', ...args], env: { GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'owner/repo' } };
  const api = vm.runInNewContext(source.slice(0, source.lastIndexOf('main().catch')) + '\n({main});', {
    ...data, ...fees, ...routes, URL, AbortSignal, Date: FixedDate, process: proc,
    console: { log() {}, error() {} }, createNotification,
    readFileSync: url => {
      if (url.href === new URL('fixture.json', root).href) return JSON.stringify({ TPE: [
        { origin: 'TPE', destination: 'ICN', pricingDate: '2027-10-08', pricingCurrency: 'TWD', pricingAmount: fare },
        { origin: 'ICN', destination: 'TPE', pricingDate: '2027-10-10', pricingCurrency: 'TWD', pricingAmount: fare },
      ] });
      return files.get(url.href);
    },
    writeFileSync: (url, text) => { writes++; files.set(url.href, text); },
    fetch: async url => { assert(url.endsWith('/issues/1/comments')); issueCalls++; return { ok: true, json: async () => ({ id: 1 }) }; },
    deliverNotifications: (queue, options) => deliverNotifications(queue, { ...options, log() {}, report() {},
      email: async () => { emailCalls++; if (failEmail) throw new Error('mail unavailable'); },
    }),
  });
  return { api, proc, files, setFare: value => { fare = value; }, failEmail: value => { failEmail = value; },
    state: () => JSON.parse(files.get(new URL('tools/state.json', root).href)),
    counts: () => ({ emailCalls, issueCalls, writes }) };
}

test('watch preserves new-low email across price baseline update and restart; Issue is not resent', async () => {
  const w = watcher();
  await w.api.main(); // Establish baseline and send daily summary.
  w.setFare(1000);
  w.failEmail(true);
  await w.api.main();
  const pending = w.state().pendingNotifications;
  assert.equal(pending.length, 1);
  assert(pending[0].kind.includes('newlow'));
  assert.equal(pending[0].issueSent, true);
  assert.equal(w.proc.exitCode, 1);
  const issueCount = w.counts().issueCalls;
  assert([...w.files.entries()].some(([name, text]) => name.endsWith('/status.json') && text.includes('通知失敗')));
  w.failEmail(false);
  w.proc.exitCode = 0;
  await w.api.main(); // Same fares: detect no longer sees new-low, queue still retries.
  assert.equal(w.state().pendingNotifications.length, 0);
  assert.equal(w.counts().issueCalls, issueCount);
  assert.equal(w.proc.exitCode, 0);
});

test('dry-run performs no delivery and no file writes', async () => {
  const w = watcher(['--dry', '--summary']);
  await w.api.main();
  assert.deepEqual(w.counts(), { emailCalls: 0, issueCalls: 0, writes: 0 });
});
