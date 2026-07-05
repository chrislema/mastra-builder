import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateJudgment,
  judgeOutputSchemaForRubric,
  type JudgeOutput,
  type Rubric,
} from '../../src/mastra/delivery-engine/judgment.ts';

const rubric: Rubric = {
  target: { name: 'test-rubric' },
  scale: { min: 1, max: 5 },
  gates: [
    { id: 'g_critical', severity: 'critical', on_fail: 'cap', cap_value: 0, check: 'llm' },
    { id: 'g_minor', severity: 'minor', on_fail: 'cap', cap_value: 0.5, check: { deterministic: 'some_check' } },
  ],
  dimensions: [
    { id: 'a', weight: 10, anchors: { '5': 'perfect a' } },
    { id: 'b', weight: 5, anchors: { '5': 'perfect b' } },
    { id: 'c', weight: 5, anchors: { '5': 'perfect c' } },
  ],
};

const allPass: JudgeOutput = {
  gates: [{ id: 'g_critical', passed: true, evidence: 'x' }],
  dimensions: [
    { id: 'a', score: 5, evidence: 'x' },
    { id: 'b', score: 5, evidence: 'x' },
    { id: 'c', score: 5, evidence: 'x' },
  ],
};

const detPass = [{ id: 'g_minor', passed: true, reason: 'ok' }];

const run = (judgeOutput: JudgeOutput, deterministicResults = detPass) =>
  aggregateJudgment({ rubric, judgeOutput, deterministicResults });

test('aggregateJudgment scores perfect output as 1.0 and passing', () => {
  const judgment = run(allPass);
  assert.equal(judgment.overall, 1);
  assert.equal(judgment.passed, true);
});

test('aggregateJudgment normalizes floor scores to zero', () => {
  const judgment = run({
    ...allPass,
    dimensions: allPass.dimensions.map((dimension) => ({ ...dimension, score: 1 })),
  });
  assert.equal(judgment.overall, 0);
  assert.equal(judgment.passed, false);
});

test('aggregateJudgment applies weighted averages', () => {
  const judgment = run({
    ...allPass,
    dimensions: [
      { id: 'a', score: 5, evidence: 'x' },
      { id: 'b', score: 3, evidence: 'x' },
      { id: 'c', score: 1, evidence: 'x' },
    ],
  });
  assert.equal(judgment.overall, 0.625);
});

test('aggregateJudgment applies critical and minor gate caps', () => {
  const critical = run({
    ...allPass,
    gates: [{ id: 'g_critical', passed: false, evidence: 'violated' }],
  });
  assert.equal(critical.overall, 0);
  assert.equal(critical.overall_uncapped, 1);
  assert.equal(critical.passed, false);

  const minor = run(allPass, [{ id: 'g_minor', passed: false, reason: 'incomplete' }]);
  assert.equal(minor.overall, 0.5);
});

test('aggregateJudgment renormalizes not-scored dimensions', () => {
  const judgment = run({
    ...allPass,
    dimensions: [
      { id: 'a', score: 5, evidence: 'x' },
      { id: 'b', score: null, evidence: '', not_scored_reason: 'out of scope' },
      { id: 'c', score: 3, evidence: 'x' },
    ],
  });
  assert.equal(judgment.overall, 0.833);
  assert.deepEqual(judgment.dimensions_not_scored, [{ id: 'b', reason: 'out of scope' }]);
});

test('aggregateJudgment fails closed on missing gates and dimensions', () => {
  const missingGate = run({ ...allPass, gates: [] });
  assert.deepEqual(missingGate.gates_failed, ['g_critical']);
  assert.equal(missingGate.overall, 0);

  const missingDimension = run({ ...allPass, dimensions: allPass.dimensions.slice(0, 2) });
  assert.deepEqual(missingDimension.dimensions_missing, ['c']);
  assert.equal(missingDimension.passed, false);
});

test('judgeOutputSchemaForRubric rejects missing rubric ids before aggregation', () => {
  const schema = judgeOutputSchemaForRubric(rubric);
  const parsed = schema.safeParse({ gates: [], dimensions: [] });

  assert.equal(parsed.success, false);
  const messages = parsed.error?.issues.map((issue) => issue.message) ?? [];
  assert.equal(messages.includes('missing required LLM gate "g_critical"'), true);
  assert.equal(messages.includes('missing required dimension "a"'), true);
});

test('aggregateJudgment includes gate and weak-dimension remediation', () => {
  const judgment = run({
    gates: [{ id: 'g_critical', passed: false, evidence: 'bad' }],
    dimensions: [
      { id: 'a', score: 2, evidence: 'thin' },
      { id: 'b', score: 5, evidence: 'x' },
      { id: 'c', score: 5, evidence: 'x' },
    ],
  });
  assert.equal(judgment.remediation.length, 2);
  assert.match(judgment.remediation[0], /GATE g_critical/);
  assert.match(judgment.remediation[1], /DIMENSION a/);
});

test('aggregateJudgment rejects scores outside the rubric scale', () => {
  assert.throws(
    () =>
      run({
        ...allPass,
        dimensions: [
          { id: 'a', score: 6, evidence: 'x' },
          { id: 'b', score: 5, evidence: 'x' },
          { id: 'c', score: 5, evidence: 'x' },
        ],
      }),
    /outside scale/,
  );
});
