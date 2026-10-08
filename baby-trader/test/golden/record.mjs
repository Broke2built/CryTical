// Re-record the behavior baseline. Only do this when you CHANGED behavior on purpose,
// then review `git diff test/golden/recording.json` line by line before committing.
import { writeFileSync } from 'node:fs';
import { runScenarios } from './scenarios.mjs';
const rec = await runScenarios();
writeFileSync(new URL('./recording.json', import.meta.url), JSON.stringify(rec, null, 1) + '\n');
console.log(`recorded ${rec.length} ticks, ${rec.reduce((a, t) => a + t.sent.length, 0)} transactions`);
