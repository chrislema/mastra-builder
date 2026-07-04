import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const rubricDir = join(process.cwd(), 'src/mastra/delivery-engine/rubrics');

type RubricFile = {
  target?: { name?: string };
  gates?: Array<{ id: string }>;
  exemplars?: {
    known_good?: {
      expected?: { gates_failed?: string[]; overall_min?: number; overall_max?: number };
    };
    known_bad?: {
      expected?: { gates_failed?: string[]; overall_min?: number; overall_max?: number };
    };
  };
};

const rubricFiles = [
  ...readdirSync(rubricDir)
    .filter((file) => file.endsWith('.rubric.json'))
    .map((file) => join(rubricDir, file)),
  ...readdirSync(join(rubricDir, 'trajectory'))
    .filter((file) => file.endsWith('.rubric.json'))
    .map((file) => join(rubricDir, 'trajectory', file)),
];

test('rubric exemplars reference real gates and score expectations', () => {
  assert.ok(rubricFiles.length > 0);

  for (const file of rubricFiles) {
    const rubric = JSON.parse(readFileSync(file, 'utf8')) as RubricFile;
    const gateIds = new Set((rubric.gates ?? []).map((gate) => gate.id));
    const good = rubric.exemplars?.known_good?.expected;
    const bad = rubric.exemplars?.known_bad?.expected;

    assert.ok(good, `${file} missing known_good expected contract`);
    assert.ok(bad, `${file} missing known_bad expected contract`);
    assert.equal(typeof (good.overall_min ?? good.overall_max), 'number', `${file} known_good missing score bound`);
    assert.equal(typeof (bad.overall_min ?? bad.overall_max), 'number', `${file} known_bad missing score bound`);

    for (const gate of [...(good.gates_failed ?? []), ...(bad.gates_failed ?? [])]) {
      assert.equal(gateIds.has(gate), true, `${file} exemplar references unknown gate ${gate}`);
    }
  }
});
