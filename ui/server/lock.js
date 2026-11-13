// Cross-process lock: mkdir is atomic. One lock per project key directory.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock(dir, fn, { staleMs = 15000, timeoutMs = 10000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const start = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmdirSync(lock);
      } catch { /* released by the holder meanwhile */ }
      if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${lock}`);
      sleep(delay);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

export function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleep(10);
    }
  }
}
