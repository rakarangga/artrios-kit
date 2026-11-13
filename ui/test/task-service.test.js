import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCard, serializeCard } from '../server/card.js';
import { createTaskService } from '../server/task-service.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'artrios-task.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-task-'));
const fresh = (opts = {}) => {
  const dir = tmp();
  const events = [];
  const svc = createTaskService({ tasksRoot: path.join(dir, 'tasks'), hat: 'self', emit: (e) => events.push(e), ...opts });
  return { dir, svc, events };
};

const PRD_EXAMPLE = `---
key: AIOS-55
project: AIOS
hat: self            # work | self
kind: task           # task | approval_request
title: PRD /artrios-ui fase 1
status: todo
cancelled: false
priority: high
due: 2026-11-07
parent: AIOS-48
labels: []
created: 2026-11-03T22:55+07:00
updated: 2026-11-04T09:00+07:00
schema: 1
---
Deskripsi bebas (Markdown).

## Catatan
- 2026-11-04: paragraf catatan bertanggal.
`;

test('parses the PRD example card and keeps the body', () => {
  const { meta, body } = parseCard(PRD_EXAMPLE);
  assert.equal(meta.key, 'AIOS-55');
  assert.equal(meta.hat, 'self');
  assert.equal(meta.cancelled, false);
  assert.equal(meta.schema, 1);
  assert.deepEqual(meta.labels, []);
  assert.equal(meta.created, '2026-11-03T22:55+07:00');
  assert.match(body, /^Deskripsi bebas/);
});

test('serialize then parse round-trips tricky values', () => {
  const meta = { key: 'A-1', project: 'A', hat: 'work', title: 'Fix: "quotes", # hash, and, commas', status: 'todo', cancelled: false, priority: 'none', due: '', parent: '', labels: ['x y', 'true'], created: 'c', updated: 'u', schema: 1, extra: 'kept' };
  const back = parseCard(serializeCard({ meta, body: 'x\n' }));
  assert.deepEqual(back.meta, meta);
});

test('create assigns sequential keys and writes the 8a layout', () => {
  const { dir, svc, events } = fresh();
  const a = svc.create({ project: 'AIOS', title: 'first' }, { by: 'ui' });
  const b = svc.create({ project: 'AIOS', title: 'second', priority: 'high', due: '2026-11-07', labels: ['x'] });
  assert.equal(a.key, 'AIOS-1');
  assert.equal(b.key, 'AIOS-2');
  assert.ok(fs.existsSync(path.join(dir, 'tasks', 'AIOS', 'AIOS-2.md')));
  assert.equal(b.client, '');
  assert.equal('hat' in parseCard(fs.readFileSync(b.file, 'utf8')).meta, false);
  assert.equal(b.status, 'backlog');
  assert.deepEqual(events.map((e) => [e.type, e.ref, e.by]), [['card.created', 'AIOS-1', 'ui'], ['card.created', 'AIOS-2', 'skill']]);
  assert.equal(fs.readdirSync(path.join(dir, 'tasks', 'AIOS')).filter((f) => f.startsWith('.')).length, 0, 'lock released');
});

test('index never reuses a number and honors nextIndex in project.json', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.artrios'));
  fs.writeFileSync(path.join(dir, '.artrios', 'project.json'), JSON.stringify({ key: 'K', hat: 'work', nextIndex: 40 }));
  const svc = createTaskService({ tasksRoot: path.join(dir, 'tasks'), projectDir: dir });
  assert.equal(svc.create({ project: 'K', title: 't' }).key, 'K-40');
  assert.equal(svc.create({ project: 'K', title: 't' }).key, 'K-41');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.artrios', 'project.json'), 'utf8')).nextIndex, 42);
  fs.rmSync(path.join(dir, 'tasks', 'K', 'K-41.md'));
  assert.equal(svc.create({ project: 'K', title: 't' }).key, 'K-42');
});

test('move updates status and updated, emits card.moved; unrelated fields stay', () => {
  let t = 0;
  const { svc, events } = fresh({ now: () => new Date(2026, 10, 5, 9, t++) });
  const c = svc.create({ project: 'A', title: 'one', body: 'desc' });
  const m = svc.move(c.key, 'in_progress', { by: 'agent' });
  assert.equal(m.status, 'in_progress');
  assert.equal(m.body, 'desc\n');
  assert.notEqual(m.updated, c.updated);
  assert.deepEqual(events.at(-1), { ts: m.updated, type: 'card.moved', ref: 'A-1', by: 'agent', detail: 'in_progress' });
  const same = svc.move(c.key, 'in_progress');
  assert.equal(same.updated, m.updated, 'no-op does not rewrite');
});

test('cancelled implies done, and leaving done clears it', () => {
  const { svc } = fresh();
  const c = svc.create({ project: 'A', title: 'x', status: 'todo' });
  const x = svc.update(c.key, { cancelled: true });
  assert.equal(x.status, 'done');
  assert.equal(x.cancelled, true);
  const y = svc.move(c.key, 'todo');
  assert.equal(y.cancelled, false);
});

test('note appends a dated line under Catatan, creating the section once', () => {
  const { svc } = fresh({ now: () => new Date(2026, 10, 5, 9, 0) });
  const c = svc.create({ project: 'A', title: 'x', body: 'desc' });
  svc.note(c.key, 'satu');
  const n = svc.note(c.key, 'dua');
  assert.equal(n.body, 'desc\n\n## Catatan\n- 2026-11-05: satu\n- 2026-11-05: dua\n');
});

test('note inserts inside an existing Catatan section before a later heading', () => {
  const { svc } = fresh({ now: () => new Date(2026, 10, 5, 9, 0) });
  const c = svc.create({ project: 'A', title: 'x', body: '## Catatan\n- lama\n\n## Lain\nisi' });
  assert.equal(svc.note(c.key, 'baru').body, '## Catatan\n- lama\n- 2026-11-05: baru\n\n## Lain\nisi\n');
});

test('invalid input is rejected and nothing is written', () => {
  const { dir, svc } = fresh();
  assert.throws(() => svc.create({ project: 'A', title: '' }), { code: 'invalid' });
  assert.throws(() => svc.create({ project: 'a/../b', title: 'x' }), { code: 'invalid' });
  assert.throws(() => svc.create({ project: 'A', title: 'x', status: 'nope' }), { code: 'invalid' });
  assert.throws(() => svc.create({ project: 'A', title: 'x', due: '5 Nov' }), { code: 'invalid' });
  assert.throws(() => svc.show('../../etc'), { code: 'invalid' });
  assert.throws(() => svc.show('A-9'), { code: 'not_found' });
  assert.ok(!fs.existsSync(path.join(dir, 'tasks', 'A')) || fs.readdirSync(path.join(dir, 'tasks', 'A')).length === 0);
});

test('broken cards are reported, never rewritten or deleted', () => {
  const { dir, svc } = fresh();
  svc.create({ project: 'A', title: 'good' });
  const bad = path.join(dir, 'tasks', 'A', 'A-2.md');
  fs.writeFileSync(bad, '---\nkey: A-2\ntitle: x\nnested:\n  - a\n---\nbody');
  const wrongStatus = path.join(dir, 'tasks', 'A', 'A-3.md');
  fs.writeFileSync(wrongStatus, serializeCard({ meta: { key: 'A-3', project: 'A', hat: 'self', title: 't', status: 'weird', priority: 'none' }, body: '' }));
  const { cards, broken } = svc.list({ project: 'A' });
  assert.equal(cards.length, 1);
  assert.equal(broken.length, 2);
  const before = fs.readFileSync(bad, 'utf8');
  assert.throws(() => svc.move('A-2', 'done'), { code: 'broken' });
  assert.equal(fs.readFileSync(bad, 'utf8'), before);
  assert.equal(svc.create({ project: 'A', title: 'next' }).key, 'A-4', 'broken numbers stay reserved');
});

test('approval_request cards and unknown fields are tolerated and preserved', () => {
  const { dir, svc } = fresh();
  const file = path.join(dir, 'tasks', 'A', 'A-1.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeCard({ meta: { key: 'A-1', project: 'A', hat: 'self', kind: 'approval_request', title: 'izinkan?', status: 'human_review', cancelled: false, priority: 'none', requestedBy: 'agent-x', decision: '', schema: 1 }, body: '' }));
  const moved = svc.move('A-1', 'done');
  assert.equal(moved.kind, 'approval_request');
  assert.equal(moved.requestedBy, 'agent-x');
});

test('a stale lock does not block forever', () => {
  const { dir, svc } = fresh();
  const lock = path.join(dir, 'tasks', 'A', '.lock');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(svc.create({ project: 'A', title: 'x' }).key, 'A-1');
});

test('AC4: parallel creates from separate processes get unique sequential keys', async () => {
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const N = 8;
  const run = (i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'add', '--root', root, '--project-dir', dir, '--project', 'P', '--hat', 'work', '--title', `t${i}`, '--json']);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out).key) : reject(new Error(err))));
  });
  const keys = await Promise.all(Array.from({ length: N }, (_, i) => run(i)));
  assert.equal(new Set(keys).size, N);
  assert.deepEqual([...keys].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))), Array.from({ length: N }, (_, i) => `P-${i + 1}`));
});

test('AC4: two writers editing different fields of one card do not corrupt it', async () => {
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const svc = createTaskService({ tasksRoot: root, hat: 'work' });
  const c = svc.create({ project: 'P', title: 'shared' });
  const cli = (...args) => new Promise((resolve) => spawn(process.execPath, [CLI, ...args, '--root', root, '--project-dir', dir]).on('close', resolve));
  const codes = await Promise.all([...Array.from({ length: 5 }, (_, i) => cli('note', c.key, `n${i}`)), cli('move', c.key, 'todo')]);
  assert.deepEqual(codes, Array(6).fill(0));
  const final = svc.show(c.key);
  assert.equal(final.status, 'todo');
  assert.equal(final.body.match(/^- \d{4}-\d{2}-\d{2}: n\d$/gm).length, 5);
  assert.equal(svc.list().broken.length, 0);
});

test('AC5: 100 cards load in well under 2 seconds', () => {
  const { svc } = fresh();
  for (let i = 0; i < 100; i++) svc.create({ project: 'S', title: `card ${i}`, body: 'x' });
  const t0 = performance.now();
  const { cards } = svc.list();
  assert.equal(cards.length, 100);
  assert.ok(performance.now() - t0 < 2000);
});

test('CLI: add, list, move, note, show, bad input exit codes', () => {
  const dir = tmp();
  const base = ['--root', path.join(dir, 'tasks'), '--project-dir', dir];
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, ...base], { encoding: 'utf8' });
  assert.equal(run('add', '--project', 'Z', '--hat', 'self', '--title', 'hello', '--priority', 'high').status, 0);
  assert.match(run('list').stdout, /Z-1\s+backlog\s+high\s+-\s+hello/);
  assert.equal(run('move', 'Z-1', 'todo').status, 0);
  assert.equal(run('note', 'Z-1', 'catatan').status, 0);
  assert.match(run('show', 'Z-1').stdout, /status: todo[\s\S]*## Catatan/);
  const log = fs.readFileSync(path.join(dir, '.artrios', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => [l.project, l.type, l.ref, l.by]), [['Z', 'card.created', 'Z-1', 'skill'], ['Z', 'card.moved', 'Z-1', 'skill'], ['Z', 'card.updated', 'Z-1', 'skill']]);
  const bad = run('move', 'Z-1', 'nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /status must be one of/);
  assert.equal(run('show', 'Z-99').status, 1);
});

test('AC 30a: a legacy hat card reads as client and is rewritten with client only when changed', () => {
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const svc = createTaskService({ tasksRoot: root, client: '', workClient: 'Acme Corp' });
  fs.mkdirSync(path.join(root, 'L'), { recursive: true });
  const w = path.join(root, 'L', 'L-1.md');
  const s = path.join(root, 'L', 'L-2.md');
  fs.writeFileSync(w, serializeCard({ meta: { key: 'L-1', project: 'L', hat: 'work', kind: 'task', title: 'old work', status: 'todo', cancelled: false, priority: 'none', schema: 1 }, body: '' }));
  fs.writeFileSync(s, serializeCard({ meta: { key: 'L-2', project: 'L', hat: 'self', kind: 'task', title: 'old own', status: 'todo', cancelled: false, priority: 'none', schema: 1 }, body: '' }));
  const before = fs.readFileSync(w, 'utf8');
  const { cards, broken } = svc.list({ project: 'L' });
  assert.deepEqual(broken, []);
  assert.deepEqual(cards.map((c) => [c.key, c.client, 'hat' in c]), [['L-1', 'Acme Corp', false], ['L-2', '', false]]);
  assert.equal(fs.readFileSync(w, 'utf8'), before, 'reading never rewrites');
  assert.deepEqual(svc.list({ client: 'Acme Corp' }).cards.map((c) => c.key), ['L-1']);
  assert.deepEqual(svc.list({ client: '' }).cards.map((c) => c.key), ['L-2']);
  assert.deepEqual(svc.list({ hat: 'work' }).cards.map((c) => c.key), ['L-1'], 'legacy hat filter still works');
  svc.move('L-1', 'done');
  svc.note('L-2', 'catatan');
  const m1 = parseCard(fs.readFileSync(w, 'utf8')).meta;
  const m2 = parseCard(fs.readFileSync(s, 'utf8')).meta;
  assert.deepEqual([m1.client, 'hat' in m1, m2.client, 'hat' in m2], ['Acme Corp', false, '', false]);
  assert.equal(svc.update('L-2', { client: 'Beta' }).client, 'Beta');
  assert.equal(svc.update('L-2', { hat: 'self' }).client, '', 'old API hat maps to client');
  assert.throws(() => svc.update('L-2', { client: 'a\nb' }), /client/);
  fs.writeFileSync(path.join(root, 'L', 'L-3.md'), serializeCard({ meta: { key: 'L-3', project: 'L', hat: 'weird', title: 't', status: 'todo', priority: 'none' }, body: '' }));
  assert.equal(svc.list({ project: 'L' }).broken.length, 1);
});

test('AC 30a: new cards get client from input, legacy hat, or the project, never hat', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.artrios'));
  fs.writeFileSync(path.join(dir, '.artrios', 'project.json'), JSON.stringify({ key: 'P', hat: 'work', nextIndex: 1 }));
  const svc = createTaskService({ tasksRoot: path.join(dir, 'tasks'), projectDir: dir, workClient: 'Acme Corp' });
  assert.equal(svc.create({ project: 'P', title: 'from project.json' }).client, 'Acme Corp');
  assert.equal(svc.create({ project: 'P', title: 'own', client: '' }).client, '');
  assert.equal(svc.create({ project: 'P', title: 'legacy', hat: 'self' }).client, '');
  const c = svc.create({ project: 'P', title: 'named', client: 'Beta' });
  const meta = parseCard(fs.readFileSync(c.file, 'utf8')).meta;
  assert.deepEqual([meta.client, 'hat' in meta], ['Beta', false]);
});

test('AC 30a: CLI lists and adds by client', () => {
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--root', root, '--project-dir', dir], { encoding: 'utf8' });
  assert.equal(run('add', '--project', 'Q', '--client', 'Acme', '--title', 'a').status, 0);
  assert.equal(run('add', '--project', 'Q', '--client', '', '--title', 'b').status, 0);
  assert.equal(run('add', '--project', 'Q', '--hat', 'work', '--work-client', 'Old Co', '--title', 'c').status, 0);
  assert.match(run('list', '--client', 'Acme').stdout, /Q-1 .*\(Acme\)/);
  const own = run('list', '--client', '').stdout;
  assert.match(own, /Q-2/);
  assert.doesNotMatch(own, /Q-1|Q-3/);
  assert.match(run('list').stdout, /Q-3 .*\(Old Co\)/);
});

test('M6: CLI matches the old tracker commands (done, due, rename, prio, parent, label, labels, legacy forms)', () => {
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--root', root, '--project-dir', dir], { encoding: 'utf8' });
  const ok = (...a) => { const r = run(...a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout; };
  const meta = (k) => parseCard(fs.readFileSync(path.join(root, k.split('-')[0], `${k}.md`), 'utf8')).meta;
  ok('add', 'R', 'first', 'card', '--client', 'Acme', '--priority', 'high', '--label', 'ai');
  ok('add', 'self', 'R', 'second', '--state', 'progress');
  ok('add', 'R', 'third', '--status', 'cancelled');
  assert.deepEqual([meta('R-1').title, meta('R-1').client, meta('R-1').labels], ['first card', 'Acme', ['ai']]);
  assert.deepEqual([meta('R-2').status, meta('R-2').client], ['in_progress', '']);
  assert.deepEqual([meta('R-3').status, meta('R-3').cancelled], ['done', true]);
  // list: open only by default, --all shows done, --label filters, legacy "list self R"
  assert.doesNotMatch(ok('list', 'R'), /R-3/);
  assert.match(ok('list', 'R', '--all'), /R-3 .*\[cancelled\]/);
  assert.doesNotMatch(ok('list', '--label', 'ai'), /R-2/);
  assert.match(ok('list', 'self', 'R'), /R-2/);
  assert.doesNotMatch(ok('list', 'self'), /R-1/);
  ok('move', 'work', 'R-2', 'todo');
  assert.equal(meta('R-2').status, 'todo');
  ok('done', 'R-2');
  assert.equal(meta('R-2').status, 'done');
  ok('move', 'R-2', 'cancelled');
  assert.equal(meta('R-2').cancelled, true);
  ok('due', 'R-1', '2026-12-01', 'R-2');
  assert.deepEqual([meta('R-1').due, meta('R-2').due], ['2026-12-01', '2026-12-01']);
  ok('due', 'R-2', 'none');
  assert.equal(meta('R-2').due, '');
  ok('rename', 'R-1', 'renamed', 'card');
  assert.equal(meta('R-1').title, 'renamed card');
  ok('prio', 'R-1', 'URGENT', 'R-2');
  assert.deepEqual([meta('R-1').priority, meta('R-2').priority], ['urgent', 'urgent']);
  ok('parent', 'R-1', 'R-2', 'R-3');
  assert.deepEqual([meta('R-2').parent, meta('R-3').parent], ['R-1', 'R-1']);
  ok('parent', 'none', 'R-3');
  assert.equal(meta('R-3').parent, '');
  assert.equal(run('parent', 'R-9', 'R-2').status, 1, 'missing parent is refused');
  assert.equal(run('parent', 'R-1', 'R-1').status, 1, 'own parent is refused');
  ok('label', 'R-1', 'waiting', 'quick');
  ok('label', 'R-1', '-ai', '-quick');
  assert.deepEqual(meta('R-1').labels, ['waiting']);
  ok('note', 'work', 'R-1', 'two', 'words');
  assert.match(fs.readFileSync(path.join(root, 'R', 'R-1.md'), 'utf8'), /## Catatan\n- \d{4}-\d{2}-\d{2}: two words/);
  assert.match(ok('labels'), /^waiting\t1 open\t-$/m);
  assert.equal(run('prio', 'R-1', 'huge').status, 1);
  assert.equal(run('due', 'R-1', '1-12-2026').status, 1);
  assert.equal(run('rename', 'R-1').status, 1);
});

test('M6: CLI in an instance uses its central tasksRoot, workspaces, label scheme, and refuses {hat}', () => {
  const inst = tmp();
  const ws = tmp();
  const root = path.join(inst, 'tasks');
  const write = (cfg) => {
    fs.mkdirSync(path.join(inst, 'data'), { recursive: true });
    fs.writeFileSync(path.join(inst, 'data', 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(inst, 'data', 'projects.json'), JSON.stringify({ projects: [{ key: 'W', name: 'W', path: ws, hat: 'work' }] }));
  };
  const elsewhere = tmp(); // cwd that is not a workspace: no .artrios may appear there
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--instance', inst], { encoding: 'utf8', cwd: elsewhere });
  write({ tasksRoot: path.join(inst, 'tasks', '{hat}') });
  const refused = run('list');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\{hat\}/);
  write({ tasksRoot: root, legacyWorkClient: 'Acme Corp', labels: { ai: 'agent can finish it', owner: 'needs the owner' } });
  assert.equal(run('add', 'W', 'registered').status, 0);
  assert.equal(parseCard(fs.readFileSync(path.join(root, 'W', 'W-1.md'), 'utf8')).meta.client, 'Acme Corp', 'client from the workspace row');
  assert.ok(fs.existsSync(path.join(ws, '.artrios', 'activity.jsonl')), 'activity goes to the registered workspace');
  // unregistered project: client follows its existing cards; nothing is written in the current folder
  fs.mkdirSync(path.join(root, 'U'), { recursive: true });
  fs.writeFileSync(path.join(root, 'U', 'U-4.md'), serializeCard({ meta: { key: 'U-4', project: 'U', client: 'Beta', kind: 'task', title: 'old', status: 'done', cancelled: false, priority: 'none', updated: '2026-01-01T00:00+07:00', schema: 1 }, body: '' }));
  const r = run('add', 'U', 'next', '--label', 'nolabel');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parseCard(fs.readFileSync(path.join(root, 'U', 'U-5.md'), 'utf8')).meta.client, 'Beta');
  const w = run('label', 'U-5', 'other');
  assert.match(w.stderr, /not in the label scheme/);
  assert.equal(fs.existsSync(path.join(elsewhere, '.artrios')), false);
  const labels = run('labels').stdout;
  assert.match(labels, /^ai\t0 open\tagent can finish it$/m);
  assert.match(labels, /^other\t1 open\t-$/m);
});

test('M6: list --format tracker is read by waitingTasks (Waiting for you)', async () => {
  const { parseTaskLines } = await import('../server/waiting-tasks.js');
  const dir = tmp();
  const root = path.join(dir, 'tasks');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--root', root, '--project-dir', dir], { encoding: 'utf8' });
  run('add', 'W', 'test on phone', '--label', 'owner', '--due', '2026-12-01', '--priority', 'high');
  run('add', 'W', 'not for the owner');
  const r = run('list', '--label', 'owner', '--format', 'tracker');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseTaskLines(r.stdout), [{ hat: '', key: 'W-1', state: 'backlog', priority: 'high', title: 'test on phone', due: '2026-12-01' }]);
  assert.equal(run('list', '--format', 'nope').status, 1);
});
