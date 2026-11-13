import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, copyTemplate } from '../bin/scaffold.js';

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AC1: scaffold copies the template without node_modules, dist, data; writes config once; reinstall keeps config and data', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-scaf-'));
  try {
    const target = path.join(tmp, 'apps', 'artrios-ui');
    const kit = path.join(tmp, 'kit');
    const r = await scaffold({ template, target, kit });
    assert.equal(r.configWritten, true);
    assert.ok(fs.existsSync(path.join(target, 'server', 'app.js')));
    assert.ok(fs.existsSync(path.join(target, 'client', 'src', 'App.jsx')));
    assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(target, 'client', 'dist')), false);
    assert.equal(r.config.maxTerminals, 12);
    assert.equal(r.config.projectLayerFile, path.join(kit, 'artrios', 'project.md'));
    assert.ok(Number.isInteger(r.config.port));
    // user edits survive a reinstall
    fs.writeFileSync(path.join(target, 'data', 'config.json'), JSON.stringify({ port: 5555, custom: true }));
    fs.writeFileSync(path.join(target, 'data', 'projects.json'), '{"projects":[]}');
    fs.writeFileSync(path.join(target, 'server', 'app.js'), '// old');
    const again = await scaffold({ template, target, kit });
    assert.equal(again.configWritten, false);
    assert.equal(again.config.custom, true);
    assert.ok(fs.existsSync(path.join(target, 'data', 'projects.json')));
    assert.notEqual(fs.readFileSync(path.join(target, 'server', 'app.js'), 'utf8'), '// old', 'source files are refreshed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scaffold refuses the template folder as target', async () => {
  await assert.rejects(() => scaffold({ template, target: template }), /template folder/);
});

test('the template copy never carries .artrios state, node_modules, dist or data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artrios-copy-'));
  try {
    const src = path.join(tmp, 'src');
    for (const d of ['.artrios', 'node_modules', 'dist', 'data', 'keep']) { fs.mkdirSync(path.join(src, d), { recursive: true }); fs.writeFileSync(path.join(src, d, 'f.txt'), 'x'); }
    copyTemplate(src, path.join(tmp, 'dst'));
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'dst')), ['keep']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
