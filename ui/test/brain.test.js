import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrain } from '../server/brain/index.js';
import { buildGraph } from '../server/brain/graph.js';
import { readBrainConfig, resolvePath } from '../server/brain/config.js';
import { buildLayers } from '../server/brain/layers.js';

const long = 'word '.repeat(80);
const NOW = Date.parse('2026-11-06T00:00:00Z');
let dir;
const put = (rel, text) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const writeConfig = (cfg) => { fs.writeFileSync(path.join(dir, 'brain.config.json'), JSON.stringify(cfg)); return path.join(dir, 'brain.config.json'); };
const byTitle = (g, t) => g.nodes.find((n) => n.title === t);
const linked = (g, a, b) => g.links.find((l) => [l.source, l.target].sort().join() === [byTitle(g, a).id, byTitle(g, b).id].sort().join());

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-brain-')));
  put('notes/alpha.md', `---\ntitle: Alpha note\nupdated: 2026-11-01\ntags: [one, two]\ndescription: The alpha.\n---\n# Ignored heading\n\nSee [[beta]] and [[missing page]]. ${long}`);
  put('notes/beta.md', `---\nupdated: 2026-11-01\n---\n# Beta note\n\nBack to [[alpha]] and [g](gamma.md) and [web](https://x.test/a.md) and [gone](nothing.md). ${long}`);
  put('notes/gamma.md', `# Gamma note\n\nA link in code does not count: \`[[alpha]]\`.\n\n\`\`\`\n[[beta]]\n\`\`\`\n`);
  put('notes/_index.md', '# Index\n\n[[alpha]]\n');
  put('notes/.hidden/secret.md', '# Secret\n');
  put('notes/node_modules/x.md', '# Vendor\n');
  put('notes/skip-me/no.md', '# Excluded\n');
  put('notes/photo.png', 'x');
  put('other/delta.md', `---\nupdated: 2020-01-01\n---\n# Delta note\n\nThis talks about the Alpha note by name, and see \`notes/beta.md\`. ${long}`);
  put('other/sub/README.md', `---\nupdated: 2026-11-01\n---\n# Sub readme\n\n${long}`);
  put('other/epsilon.md', `---\nupdated: 2026-11-01\n---\n# Epsilon note\n\nFolder reference: \`other/sub/\`. ${long}`);
  put('big.md', `# Big\n\n${'x'.repeat(1024 * 1024 + 10)}`);
  writeConfig({
    name: 'T',
    root: '.',
    sources: [
      { id: 'notes', label: 'Notes', paths: ['notes'], exclude: ['skip-me'] },
      { id: 'other', label: 'Other', paths: ['other', 'big.md', 'not-there'], staleDays: 90, color: '#112233' },
    ],
  });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('scan: notes only; hidden, vendor, excluded and oversized files stay out, with a warning for what was skipped', async () => {
  const { graph: g } = await buildGraph(path.join(dir, 'brain.config.json'), NOW);
  assert.deepEqual(g.nodes.map((n) => n.title).sort(), ['Alpha note', 'Beta note', 'Delta note', 'Epsilon note', 'Gamma note', 'Sub readme']);
  assert.deepEqual(g.indexes.map((i) => i.path), ['notes/_index.md']);
  assert.ok(g.warnings.some((w) => w.includes('over 1 MB')));
  assert.ok(g.warnings.some((w) => w.includes('not-there') && w.includes('ENOENT')));
  const a = byTitle(g, 'Alpha note');
  assert.equal(a.summary, 'The alpha.');
  assert.deepEqual(a.tags, ['one', 'two']);
  assert.equal(a.path, 'notes/alpha.md');
});

test('links: wikilink, Markdown link, backtick file and folder, cross-source mention; code is not a link', async () => {
  const { graph: g } = await buildGraph(path.join(dir, 'brain.config.json'), NOW);
  assert.equal(linked(g, 'Alpha note', 'Beta note').kind, 'link');
  assert.equal(linked(g, 'Beta note', 'Gamma note').kind, 'link');
  assert.equal(linked(g, 'Delta note', 'Beta note').kind, 'reference');
  assert.equal(linked(g, 'Epsilon note', 'Sub readme').kind, 'reference');
  assert.equal(linked(g, 'Delta note', 'Alpha note').kind, 'mention');
  assert.equal(linked(g, 'Gamma note', 'Alpha note'), undefined, 'links inside code do not count');
  assert.ok(g.links.every((l) => g.nodes.some((n) => n.id === l.source) && g.nodes.some((n) => n.id === l.target)), 'an index note never appears in a link');
});

test('flags: broken links, stub, stale per source, source totals', async () => {
  const { graph: g } = await buildGraph(path.join(dir, 'brain.config.json'), NOW);
  assert.deepEqual(byTitle(g, 'Alpha note').broken, ['missing page']);
  assert.deepEqual(byTitle(g, 'Beta note').broken, ['nothing.md'], 'a web address is not a broken link');
  assert.ok(byTitle(g, 'Alpha note').flags.includes('broken-links'));
  assert.ok(byTitle(g, 'Gamma note').flags.includes('stub'));
  assert.ok(byTitle(g, 'Delta note').flags.includes('stale'));
  assert.ok(!byTitle(g, 'Epsilon note').flags.includes('stale'));
  const other = g.sources.find((s) => s.id === 'other');
  assert.equal(other.count, 3);
  assert.equal(other.color, '#112233');
  assert.equal(other.flagged, 1);
  assert.equal(g.totals.notes, 6);
  assert.equal(g.totals.links, g.links.length);
  assert.equal(g.hubs[0], byTitle(g, 'Beta note').id);
});

test('orphan: a note without links is flagged', async () => {
  const sub = path.join(dir, 'lonely');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'one.md'), `# One\n\n${long}`);
  const cfg = path.join(sub, 'brain.config.json');
  fs.writeFileSync(cfg, JSON.stringify({ sources: [{ id: 'a', paths: ['.'] }] }));
  const { graph: g } = await buildGraph(cfg, Date.now());
  assert.deepEqual(g.nodes[0].flags, ['orphan']);
  assert.equal(g.name, 'Brain');
});

test('API: note without front matter by id, only known ids, rebuild picks up a new file', async () => {
  const brain = createBrain({ config: { brainConfigFile: path.join(dir, 'brain.config.json') }, dataDir: dir });
  const g = await brain.graph();
  const n = await brain.node(byTitle(g, 'Alpha note').id);
  assert.match(n.markdown, /^# Ignored heading/);
  assert.equal(n.path, 'notes/alpha.md');
  await assert.rejects(() => brain.node('nope'), (e) => e.code === 'not_found');
  await assert.rejects(() => brain.node(path.join(dir, 'notes', 'alpha.md')), (e) => e.code === 'not_found');
  put('notes/zeta.md', `# Zeta note\n\n${long}`);
  try {
    assert.equal(byTitle(await brain.graph(), 'Zeta note'), undefined, 'cached until rebuild');
    assert.ok(byTitle(await brain.graph(true), 'Zeta note'));
  } finally { fs.rmSync(path.join(dir, 'notes', 'zeta.md')); await brain.graph(true); }
});

test('API: missing config says what to do; a broken config is invalid', async () => {
  const brain = createBrain({ config: {}, dataDir: path.join(dir, 'empty') });
  await assert.rejects(() => brain.graph(), (e) => e.code === 'not_found' && /not configured/.test(e.message));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ nope');
  const b2 = createBrain({ config: { brainConfigFile: bad }, dataDir: dir });
  await assert.rejects(() => b2.graph(), (e) => e.code === 'invalid' && /not valid JSON/.test(e.message));
});

test('config: validation, paths against root, older files still load', async () => {
  const check = async (cfg, re) => { const f = path.join(dir, 'c.json'); fs.writeFileSync(f, JSON.stringify(cfg)); await assert.rejects(() => readBrainConfig(f), re); };
  await check({ sources: [] }, /at least one/);
  await check({ sources: [{ id: 'Bad', paths: ['a'] }] }, /lowercase/);
  await check({ sources: [{ id: 'a', paths: ['a'] }, { id: 'a', paths: ['b'] }] }, /duplicate/);
  await check({ sources: [{ id: 'a', paths: [] }] }, /paths/);
  await check({ sources: [{ id: 'a', paths: ['x'], color: 'red' }] }, /color/);
  await check({ sources: [{ id: 'a', paths: ['x'], staleDays: 0 }] }, /staleDays/);
  await check({ maxNotes: 0, sources: [{ id: 'a', paths: ['x'] }] }, /maxNotes/);
  // The shape written by the older app, with its extra fields: still fine.
  const f = path.join(dir, 'old.json');
  fs.writeFileSync(f, JSON.stringify({ name: 'Old', port: 4640, version: 1, root: '../..', maxNodes: 5, sources: [{ id: 'a', label: 'A', short: 'A', blurb: 'x', type: 'markdown', staleDays: null, paths: ['x', 'D:/abs'] }] }));
  const c = await readBrainConfig(f);
  assert.equal(c.maxNotes, 5);
  assert.equal(c.sources[0].staleDays, null);
  assert.equal(c.sources[0].paths[0], path.resolve(dir, '../..', 'x'));
  assert.equal(resolvePath('~/n', 'x'), path.join(os.homedir(), 'n'));
});

test('AIOS-93: every note carries area, entity and type; a page without entity is marked, not hidden', () => {
  const note = (p, type = '') => ({ id: p, title: p, path: p, type, degree: 0, updated: 0 });
  const L = buildLayers({
    config: { root: dir, areasDir: '' },
    notes: [
      note('knowledge/wiki/clients/acme-corp/billing/costs.md', 'analysis'),
      note('knowledge/wiki/clients/acme-corp/_index.md'),
      note('knowledge/wiki/research/sub/page.md', 'concept'),
      note('knowledge/wiki/research/top.md'),
    ],
    routines: { board: [], recent: [] },
    skills: [{ name: 'x', description: 'd' }],
  });
  const get = (p) => L.notes.find((n) => n.path === p);
  assert.deepEqual(['client', 'entity', 'type'].map((k) => get('knowledge/wiki/clients/acme-corp/billing/costs.md')[k]), ['acme-corp', 'billing', 'analysis']);
  assert.deepEqual(['client', 'entity', 'type'].map((k) => get('knowledge/wiki/clients/acme-corp/_index.md')[k]), ['acme-corp', '', 'dokumen']);
  assert.equal(get('knowledge/wiki/research/sub/page.md').entity, 'sub');
  assert.equal(get('knowledge/wiki/research/top.md').entity, '');
  assert.equal(L.notes.length, 4);
  assert.deepEqual([...new Set(L.extra.nodes.map((n) => typeof n.entity))], ['string']);
  assert.equal(L.extra.nodes.find((n) => n.kind === 'skill').type, 'skill');
});
