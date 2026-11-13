#!/usr/bin/env node
// Entry point: node server/index.js [--data DIR] [--port N]. Binds 127.0.0.1 unless config.host names a LAN address;
// either way every request needs a sign-in (PRD AIOS-61 v2.0 S1). Without an account it stops and says how to make one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { WILDCARD } from './guard.js';
import { loadJson } from './projects.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { data: { type: 'string' }, port: { type: 'string' } } });
const dataDir = path.resolve(values.data ?? path.join(root, 'data'));
const config = loadJson(path.join(dataDir, 'config.json'), {});
const port = Number(values.port ?? config.port ?? 4317);
const host = config.host ? String(config.host) : '127.0.0.1';

if (!fs.existsSync(path.join(dataDir, 'users.json'))) {
  console.error(`No account yet. Set the administrator password first:\n  npm run password${values.data ? ` -- --data "${dataDir}"` : ''}`);
  process.exit(1);
}
if (WILDCARD.has(host) && !(config.allowedHosts ?? []).length) {
  console.error(`"host": "${host}" listens on every network; list the names or addresses browsers will use in "allowedHosts" (data/config.json).`);
  process.exit(1);
}

const { server, close } = createApp({ config, dataDir, port, clientDir: path.join(root, 'client', 'dist') });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Set another "port" in ${path.join(dataDir, 'config.json')}.` : e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  // The first line is read by install.py ("Artrios UI: http://127.0.0.1:<port>/" on a default install). A LAN address
  // in "host" listens on that address only, so the browser on this PC uses it too; "0.0.0.0" also keeps 127.0.0.1.
  const local = WILDCARD.has(host) ? '127.0.0.1' : host;
  console.log(`Artrios UI: http://${local}:${port}/`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    const names = WILDCARD.has(host) ? config.allowedHosts : config.allowedHosts ?? [];
    console.log(`Open to the network${names.length ? ` (${names.join(', ')})` : ''}; every visit needs the sign-in.`);
  }
});

// No orphan claude processes after the server stops (AC 7 applies the same idea to jobs).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { close(); process.exit(0); });
process.on('exit', close);
