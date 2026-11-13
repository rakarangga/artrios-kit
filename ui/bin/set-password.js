#!/usr/bin/env node
// Sets the one account's password (PRD AIOS-61 v2.0 S1, AC 4): asked at install, also the way back in after a forgotten
// password. The account must choose a new password at its next sign-in. Running sessions end when the server restarts.
// Usage: npm run password [-- --data DIR] [--stdin]   (--stdin reads one line, for scripts and tests)
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAccount, MIN_PASSWORD, USER } from '../server/auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { data: { type: 'string' }, stdin: { type: 'boolean' } } });
const file = path.join(path.resolve(values.data ?? path.join(root, 'data')), 'users.json');

function readLine() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf.split(/\r?\n/)[0]));
  });
}

// Hidden prompt: the typed characters are not echoed.
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.output.write('\n'); rl.close(); resolve(answer); });
  });
}

let password;
if (values.stdin || !process.stdin.isTTY) {
  password = await readLine();
} else {
  console.log(`Password for "${USER}" (at least ${MIN_PASSWORD} characters). You will choose a new one at the first sign-in.`);
  password = await ask('Password: ');
  if ((await ask('Repeat:   ')) !== password) { console.error('The two passwords differ. Nothing was saved.'); process.exit(1); }
}
try {
  writeAccount(file, password, { mustChange: true });
  console.log(`Saved ${file}. Sign in as "${USER}".`);
} catch (e) {
  console.error(`${e.message}. Nothing was saved.`);
  process.exit(1);
}
