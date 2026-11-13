// Stand-in for the GitHub CLI (tests only): `auth status` follows FAKE_GH_AUTH, `auth login --web` prints a device code
// and exits after Enter (FAKE_GH_LOGIN_FAIL makes it fail), `pr create`, `auth setup-git` and `auth logout` log argv.
import fs from 'node:fs';
const args = process.argv.slice(2);
const logArgs = () => { if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(args)}\n`); };
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_GH_AUTH === 'no') { process.stderr.write('You are not logged into any GitHub hosts.\n'); process.exit(1); }
  process.stdout.write('github.com\n  ✓ Logged in to github.com account tester (keyring)\n');
  process.exit(0);
} else if (args[0] === 'auth' && args[1] === 'login') {
  logArgs();
  process.stderr.write('! One-time code (ABCD-1234) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
  process.stdin.once('data', () => setTimeout(() => process.exit(process.env.FAKE_GH_LOGIN_FAIL ? 1 : 0), Number(process.env.FAKE_GH_LOGIN_MS ?? 300)));
  process.stdin.resume();
} else if (args[0] === 'auth' && (args[1] === 'setup-git' || args[1] === 'logout')) {
  logArgs();
  process.exit(0);
} else if (args[0] === 'pr' && args[1] === 'create') {
  logArgs();
  process.stdout.write('https://github.com/example/repo/pull/7\n');
  process.exit(0);
} else {
  process.stderr.write(`fake gh: unknown command ${args.join(' ')}\n`);
  process.exit(2);
}
