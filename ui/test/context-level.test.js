import test from 'node:test';
import assert from 'node:assert/strict';
import { contextLevel, WARN_TOKENS, HIGH_TOKENS } from '../client/src/lib/context-level.js';

test('contextLevel: unknown sizes give null', () => {
  assert.equal(contextLevel(null), null);
  assert.equal(contextLevel(undefined), null);
  assert.equal(contextLevel(0), null);
  assert.equal(contextLevel(NaN), null);
});

test('contextLevel: ok below 100k, warn from 100k, high from 200k', () => {
  assert.equal(contextLevel(41_000), 'ok');
  assert.equal(contextLevel(WARN_TOKENS - 1), 'ok');
  assert.equal(contextLevel(WARN_TOKENS), 'warn');
  assert.equal(contextLevel(150_000), 'warn');
  assert.equal(contextLevel(HIGH_TOKENS), 'high');
  assert.equal(contextLevel(230_000), 'high');
});

test('contextLevel: thresholds can be overridden', () => {
  assert.equal(contextLevel(60_000, { warn: 50_000, high: 80_000 }), 'warn');
});
