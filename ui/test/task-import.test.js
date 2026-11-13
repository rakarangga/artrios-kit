// Snapshot import (PRD AIOS-61 v2.1 S12 M3 mapping, M4 dry run, AC 29-31 shape): cards with client and no hat,
// one folder per project key, counts compared, key clashes with existing file cards reported, re-run idempotent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importSnapshot, reportMarkdown } from '../server/task-import.js';
import { parseCard, serializeCard } from '../server/card.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));

const DOC = {
  source: 'tracker',
  projects: [
    { key: 'WEB', name: 'Web', hat: 'work', client: 'Client A' },
    { key: 'OWN', name: 'Own', hat: 'self', client: '' },
    { key: 'OLD', name: 'Legacy hat only', hat: 'work' },
    { key: 'EMPTY', name: 'No tasks', hat: 'self', client: '' },
  ],
  tasks: [
    { key: 'WEB-1', project: 'WEB', hat: 'work', client: 'Client A', title: 'Tax summary', status: 'done', cancelled: false, priority: 'none', due: '', parent: '', labels: [], created: '2026-11-01T09:00+07:00', updated: '2026-11-02T09:00+07:00', body: 'Old', notes: [] },
    { key: 'WEB-3', project: 'WEB', hat: 'work', client: 'Client A', title: 'Child: with notes', status: 'in_progress', cancelled: false, priority: 'high', due: '2026-11-20', parent: 'WEB-1', labels: ['ai', 'quick'], created: '2026-11-03T09:00+07:00', updated: '2026-11-04T09:00+07:00', body: 'Do it', notes: [{ date: '2026-11-05', text: 'started' }], unmapped: ['attachments:1'] },
    { key: 'WEB-4', project: 'WEB', hat: 'work', client: 'Client A', title: 'Dropped', status: 'done', cancelled: true, priority: 'low', due: '', parent: '', labels: [], created: '', updated: '', body: '', notes: [] },
    { key: 'OWN-2', project: 'OWN', hat: 'self', client: '', title: 'Own task', status: 'backlog', cancelled: false, priority: 'none', due: '', parent: '', labels: [], created: '', updated: '', body: '', notes: [] },
    { key: 'OLD-1', project: 'OLD', hat: 'work', title: 'No client field', status: 'todo', cancelled: false, priority: 'medium', due: '', parent: '', labels: [], created: '', updated: '', body: '', notes: [] },
  ],
};

function existingRoot() {
  const root = tmp();
  const dir = path.join(root, 'work', 'WEB');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WEB-1.md'), serializeCard({ meta: { key: 'WEB-1', project: 'WEB', hat: 'work', title: 'tes', status: 'backlog', priority: 'none', schema: 1 }, body: '' }));
  fs.writeFileSync(path.join(dir, 'WEB-9.md'), serializeCard({ meta: { key: 'WEB-9', project: 'WEB', hat: 'work', title: 'only in files', status: 'backlog', priority: 'none', schema: 1 }, body: '' }));
  return root;
}

test('mapping: client instead of hat, tasks/<KEY>/, notes under ## Catatan, cancelled kept', () => {
  const target = path.join(tmp(), 'tasks');
  const r = importSnapshot({ snapshotText: JSON.stringify(DOC), tasksRoot: target, clientOfWork: 'PT X' });
  assert.equal(r.written.length, 5);
  assert.deepEqual(fs.readdirSync(target).sort(), ['OLD', 'OWN', 'WEB']);
  const child = parseCard(fs.readFileSync(path.join(target, 'WEB', 'WEB-3.md'), 'utf8'));
  assert.equal(child.meta.client, 'Client A');
  assert.equal('hat' in child.meta, false);
  assert.equal(child.meta.parent, 'WEB-1');
  assert.deepEqual(child.meta.labels, ['ai', 'quick']);
  assert.equal(child.meta.due, '2026-11-20');
  assert.match(child.body, /^Do it\n\n## Catatan\n- 2026-11-05: started\n$/);
  assert.equal(parseCard(fs.readFileSync(path.join(target, 'OWN', 'OWN-2.md'), 'utf8')).meta.client, '');
  assert.equal(parseCard(fs.readFileSync(path.join(target, 'OLD', 'OLD-1.md'), 'utf8')).meta.client, 'PT X');
  const dropped = parseCard(fs.readFileSync(path.join(target, 'WEB', 'WEB-4.md'), 'utf8')).meta;
  assert.equal(dropped.status, 'done');
  assert.equal(dropped.cancelled, true);
  assert.deepEqual(r.mismatch, []);
  assert.deepEqual(r.broken, []);
  assert.deepEqual(r.legacyFolders, []);
  assert.equal(r.totals.cancelledTool, 1);
  assert.equal(r.totals.cancelledFiles, 1);
  assert.equal(r.counts.find((c) => c.project === 'WEB').nextIndex, 5);
  assert.deepEqual(r.projectsWithoutTasks, ['EMPTY']);
  assert.deepEqual(r.unmapped, [{ key: 'WEB-3', fields: ['attachments:1'] }]);
});

test('clash: an existing file card with a tool key is reported with a proposed new key; others ignored', () => {
  const target = path.join(tmp(), 'tasks');
  const r = importSnapshot({ snapshotText: JSON.stringify(DOC), tasksRoot: target, existingRoots: [existingRoot()] });
  assert.equal(r.clashes.length, 1);
  assert.equal(r.clashes[0].key, 'WEB-1');
  assert.equal(r.clashes[0].fileTitle, 'tes');
  assert.equal(r.clashes[0].toolTitle, 'Tax summary');
  assert.equal(r.clashes[0].proposedKey, 'WEB-5');
  assert.match(reportMarkdown(r), /\*\*WEB-1\*\*.*kunci baru WEB-5/);
});

test('re-run is idempotent; a hand-edited card is reported, not overwritten, unless overwrite', () => {
  const target = path.join(tmp(), 'tasks');
  const text = JSON.stringify(DOC);
  importSnapshot({ snapshotText: text, tasksRoot: target });
  const file = path.join(target, 'OWN', 'OWN-2.md');
  const before = fs.readFileSync(file, 'utf8');
  const again = importSnapshot({ snapshotText: text, tasksRoot: target });
  assert.equal(again.written.length, 0);
  assert.equal(again.unchanged.length, 5);
  fs.writeFileSync(file, before.replace('Own task', 'Edited'));
  const third = importSnapshot({ snapshotText: text, tasksRoot: target });
  assert.deepEqual(third.differs, ['OWN-2']);
  assert.match(fs.readFileSync(file, 'utf8'), /Edited/);
  const forced = importSnapshot({ snapshotText: text, tasksRoot: target, overwrite: true });
  assert.deepEqual(forced.written, ['OWN-2']);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('report: count mismatch and bad rows are flagged', () => {
  const target = path.join(tmp(), 'tasks');
  const doc = structuredClone(DOC);
  doc.tasks.push({ key: 'WEB-7', project: 'WEB', title: 'Odd', status: 'weird' });
  const r = importSnapshot({ snapshotText: JSON.stringify(doc), tasksRoot: target });
  assert.equal(r.bad.length, 1);
  fs.writeFileSync(path.join(target, 'WEB', 'WEB-8.md'), '---\nkey: WEB-8\nproject: WEB\nhat: work\ntitle: x\nstatus: todo\npriority: none\n---\n');
  const r2 = importSnapshot({ snapshotText: JSON.stringify(DOC), tasksRoot: target });
  assert.deepEqual(r2.mismatch, ['WEB']);
  assert.ok(r2.broken.some((b) => b.key === 'WEB-8' && b.problems.some((p) => /hat|client/.test(p))));
});

test('cli: dry run refuses a non-empty target and exits 0 on a clean import', () => {
  const dir = tmp();
  const snap = path.join(dir, 'snap.json');
  fs.writeFileSync(snap, JSON.stringify(DOC));
  const cli = path.join(here, '..', 'bin', 'import-tasks.js');
  const target = path.join(dir, 'out');
  const report = path.join(dir, 'report.md');
  execFileSync(process.execPath, [cli, '--snapshot', snap, '--target', target, '--dry-run', '--report', report]);
  assert.match(fs.readFileSync(report, 'utf8'), /sama semua/);
  assert.throws(() => execFileSync(process.execPath, [cli, '--snapshot', snap, '--target', target, '--dry-run'], { stdio: 'pipe' }), /status 2|Command failed/);
});
