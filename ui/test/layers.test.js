import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArea, buildLayers } from '../server/brain/layers.js';

const AREA = `---\narea: demo\n---\n# Demo\n\n## Proyek\n\n- [app-one](D:/x/app-one): tes; hat PT Contoh\n\n## Skill\n\n- [/gl](D:/x/skills/gl): graf\n\n## Bukan di sini\n\n- [ignored](D:/x): no\n`;

test('parseArea: sections map to kind and layer, hat is read from the note, other sections are ignored', () => {
  const a = parseArea(AREA, 'demo.md');
  assert.equal(a.label, 'Demo');
  assert.deepEqual(a.entries.map((e) => [e.name, e.kind, e.layer, e.hat]), [['app-one', 'app', 'apps', 'PT Contoh'], ['/gl', 'skill', 'skills', '']]);
});

test('buildLayers: without areasDir there are no areas but core, skills, routines and runs still appear; a note gets layer and area', () => {
  const L = buildLayers({
    config: { root: '.', areasDir: '' },
    notes: [{ id: 'n1', title: 'N', path: 'D:/vault/wiki/clients/x.md', degree: 0 }],
    routines: { board: [{ name: 'r1', host: 'pc', schedule: 'daily 08:00', state: 'OK', last: { t: '2026-11-08T08:00:00' }, hat: '' }], recent: [{ t: '2026-11-08T08:00:00', host: 'pc', name: 'r1', status: 'OK', detail: 'x' }] },
    skills: [{ name: 'gl', description: 'd' }],
  });
  assert.equal(L.notes[0].layer, 'memory');
  assert.deepEqual(L.extra.nodes.map((n) => n.kind).sort(), ['core', 'routine', 'run', 'skill']);
  assert.ok(L.extra.links.some((l) => l.kind === 'ran'));
});
