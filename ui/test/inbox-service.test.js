import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInboxService, InboxError } from '../server/inbox-service.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'inbox', 'events.jsonl');
const mk = (file, at = '2026-11-09T10:00:00') => createInboxService({ file, now: () => new Date(at) });
const put = { kind: 'putusan', from: 'claude', question: 'Hapus draf?', options: ['ok', 'revisi', 'hapus'], links: ['brainstorms/x.md'] };
const appr = { kind: 'approval_request', from: 'agent:server-health', agent: 'server-health', jobId: 'j1', question: 'Tulis laporan?', options: ['ok', 'revisi', 'tolak'], to: ['admin'] };

test('AC10: putusan and approval_request share one list and badge count', () => {
  const s = mk(tmp());
  s.create(put);
  s.create(appr);
  assert.equal(s.list().length, 2);
  assert.equal(s.pendingCount(), 2);
  s.decide('q-20261109-0001', { by: 'administrator', decision: 'ok' });
  assert.equal(s.pendingCount(), 1);
  assert.deepEqual(s.list({ kind: 'approval_request' }).map((i) => i.id), ['q-20261109-0002']);
});

test('putusan never expires, approval_request expires after 7 days without executing', () => {
  const f = tmp();
  mk(f).create(put);
  mk(f).create(appr);
  assert.equal(mk(f).get('q-20261109-0002').expires, '2026-11-16');
  assert.equal(mk(f).get('q-20261109-0001').expires, null);
  const later = mk(f, '2026-11-17T08:00:00');
  assert.equal(later.expire().length, 1);
  assert.equal(later.get('q-20261109-0002').status, 'expired');
  assert.equal(later.get('q-20261109-0001').status, 'pending');
  assert.throws(() => later.decide('q-20261109-0002', { by: 'admin', decision: 'ok' }), { code: 'closed' });
  assert.equal(later.expire().length, 0);
});

test('decision is final, must be an offered option, and can be applied once', () => {
  const s = mk(tmp());
  const { id } = s.create(put);
  assert.throws(() => s.decide(id, { by: 'administrator', decision: 'mungkin' }), { code: 'invalid' });
  s.decide(id, { by: 'administrator', decision: 'revisi', note: 'tambah contoh' });
  assert.throws(() => s.decide(id, { by: 'administrator', decision: 'ok' }), { code: 'closed' });
  assert.equal(s.get(id).note, 'tambah contoh');
  s.markApplied(id, { by: 'skrip' });
  assert.throws(() => s.markApplied(id, { by: 'skrip' }), { code: 'closed' });
  assert.equal(s.get(id).applied.by, 'skrip');
});

test('roles: viewer cannot decide, operator only items addressed to them', () => {
  const s = mk(tmp());
  const { id } = s.create({ ...put, to: ['administrator'] });
  assert.throws(() => s.decide(id, { by: 'sari', decision: 'ok', role: 'viewer' }), { code: 'forbidden' });
  assert.throws(() => s.decide(id, { by: 'sari', decision: 'ok', role: 'operator' }), { code: 'forbidden' });
  s.decide(id, { by: 'administrator', decision: 'ok', role: 'operator' });
});

test('stale(): pending longer than 3 days is reported (AC12)', () => {
  const f = tmp();
  mk(f, '2026-11-05T10:00:00').create(put);
  mk(f, '2026-11-08T10:00:00').create(appr);
  const s = mk(f, '2026-11-09T10:00:00');
  assert.deepEqual(s.stale().map((i) => i.id), ['q-20261105-0001']);
});

test('validation rejects bad input and broken files', () => {
  const f = tmp();
  const s = mk(f);
  assert.throws(() => s.create({ ...put, kind: 'x' }), InboxError);
  assert.throws(() => s.create({ ...put, options: [] }), { code: 'invalid' });
  assert.throws(() => s.create({ ...put, from: 'siapa' }), { code: 'invalid' });
  assert.throws(() => s.create({ ...appr, agent: null, jobId: null }), { code: 'invalid' });
  assert.throws(() => s.create({ ...put, expires: '16-11-2026' }), { code: 'invalid' });
  s.create(put);
  fs.appendFileSync(f, '{bukan json\n');
  assert.throws(() => s.list(), { code: 'broken' });
});

test('AC11: concurrent writers from separate processes do not corrupt the file', async () => {
  const f = tmp();
  const svc = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/inbox-service.js')).href;
  const code = [
    `import(${JSON.stringify(svc)}).then(({ createInboxService }) => {`,
    `  const s = createInboxService({ file: ${JSON.stringify(f)} });`,
    '  for (let i = 0; i < 15; i++) s.create({ kind: "putusan", from: "claude", question: "q" + i, options: ["ok"] });',
    '});',
  ].join('\n');
  await Promise.all([1, 2, 3, 4].map(() => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`child exit ${c}`))));
  })));
  const items = mk(f).list();
  assert.equal(items.length, 60);
  assert.equal(new Set(items.map((i) => i.id)).size, 60);
  for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) JSON.parse(l);
});
