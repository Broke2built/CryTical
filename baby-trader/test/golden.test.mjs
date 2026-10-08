// Behavior lock: worker.js must do EXACTLY what test/golden/recording.json says.
// Fails on any change to transactions, stored state or log text. See test/golden/scenarios.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenarios } from './golden/scenarios.mjs';

test('golden master: identical transactions, KV state and logs across 12 scripted ticks', async () => {
  const want = JSON.parse(readFileSync(new URL('./golden/recording.json', import.meta.url), 'utf8'));
  const got = JSON.parse(JSON.stringify(await runScenarios()));
  assert.equal(got.length, want.length);
  for (let k = 0; k < want.length; k++) {
    assert.deepEqual(got[k].sent, want[k].sent, `tick "${want[k].label}": transactions differ`);
    assert.deepEqual(got[k].state, want[k].state, `tick "${want[k].label}": stored state differs`);
    assert.deepEqual(got[k].logs, want[k].logs, `tick "${want[k].label}": log output differs`);
  }
});
