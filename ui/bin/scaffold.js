#!/usr/bin/env node
// Installer used by the /artrios-ui skill: copies this ui/ template into <target> (default apps/artrios-ui),
// writes data/config.json once (free port, project layer file) and never touches an existing config.json or data/.
// Usage: node bin/scaffold.js --target DIR [--kit KITROOT] [--port N] [--keys-file FILE]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// .artrios holds a project's own state (tasks, jobs, logs): it never belongs to the template.
const SKIP = new Set(['node_modules', 'dist', 'data', '.git', '.artrios']);

export function copyTemplate(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTemplate(from, to);
    else fs.copyFileSync(from, to);
  }
}

export function freePort(start = 4317) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(freePort(start + 1)) : reject(e)));
    s.listen(start, '127.0.0.1', () => s.close(() => resolve(start)));
  });
}

export async function scaffold({ template, target, kit, port, envFile }) {
  const dst = path.resolve(target);
  if (path.resolve(template) === dst) throw new Error('target is the template folder itself');
  copyTemplate(template, dst);
  const dataDir = path.join(dst, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfgFile = path.join(dataDir, 'config.json');
  let configWritten = false;
  if (!fs.existsSync(cfgFile)) {
    const cfg = { port: port ?? (await freePort()), maxTerminals: 12 };
    if (kit) {
      cfg.projectLayerFile = path.join(path.resolve(kit), 'artrios', 'project.md');
      cfg.providersFile = path.join(path.resolve(kit), 'artrios', 'providers.yaml');
    }
    if (envFile) cfg.envFile = path.resolve(envFile);
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    configWritten = true;
  }
  return { target: dst, configWritten, config: JSON.parse(fs.readFileSync(cfgFile, 'utf8')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { target: { type: 'string' }, kit: { type: 'string' }, port: { type: 'string' }, 'keys-file': { type: 'string' } } });
  if (!values.target) { console.error('usage: node bin/scaffold.js --target DIR [--kit KITROOT] [--port N] [--keys-file FILE]'); process.exit(2); }
  const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  scaffold({ template, target: values.target, kit: values.kit, port: values.port ? Number(values.port) : undefined, envFile: values['keys-file'] })
    .then((r) => console.log(`${r.configWritten ? 'created' : 'kept'} ${path.join(r.target, 'data', 'config.json')} (port ${r.config.port})\nscaffolded ${r.target}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
