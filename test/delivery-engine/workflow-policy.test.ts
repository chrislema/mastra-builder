import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldProceedAfterNonActionableImplementationJudgment,
  shouldSuspendForPlannerQuestions,
  verificationWithAcceptanceGaps,
} from '../../src/mastra/delivery-engine/workflow.ts';

const readout = (blocking_ambiguities: string[]) => ({
  artifact_type: 'readout' as const,
  product_intent: 'intent',
  technical_shape: 'shape',
  safe_assumptions: [],
  blocking_ambiguities,
  recommended_next_step: 'next',
});

const taskPlan = (tasks: Array<{ depends_on: string[]; acceptance_criteria?: string[]; owned_surfaces?: string[] }>) => ({
  artifact_type: 'task-plan' as const,
  scope: 'scope',
  tasks: tasks.map((task, index) => ({
    id: `T${index + 1}`,
    owner: 'engineer' as const,
    deliverable: 'deliverable',
    depends_on: task.depends_on,
    acceptance_criteria: task.acceptance_criteria ?? ['verified'],
    owned_surfaces: task.owned_surfaces ?? ['src/index.ts'],
  })),
  technology_decisions: [],
  open_decisions: [],
  risks: [],
});

test('planner questions are deferred when a task plan has an executable root task', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(readout(['Confirm downstream integration detail.']), taskPlan([{ depends_on: [] }])),
    false,
  );
});

test('planner questions suspend when no executable root task exists', () => {
  assert.equal(shouldSuspendForPlannerQuestions(readout(['Cannot start safely.']), taskPlan([])), true);
});

test('implementation notes list acceptance criteria that workflow verification did not run', () => {
  const [task] = taskPlan([
    {
      depends_on: [],
      acceptance_criteria: [
        'TypeScript typecheck passes.',
        'wrangler dev starts the Worker locally without errors.',
        'Worker entry point returns HTTP 200 on GET /health.',
      ],
    },
  ]).tasks;

  const verification = verificationWithAcceptanceGaps({
    task,
    verification: {
      performed: ['npm run typecheck passed'],
      missing: [],
    },
  });

  assert.deepEqual(verification.performed, ['npm run typecheck passed']);
  assert.deepEqual(verification.missing, [
    'Acceptance criterion not verified by automated checks: wrangler dev starts the Worker locally without errors.',
    'Acceptance criterion not verified by automated checks: Worker entry point returns HTTP 200 on GET /health.',
  ]);
});

const implementationNote = {
  artifact_type: 'implementation-note' as const,
  task: 'T1',
  changes: ['Implemented T1'],
  files_touched: ['src/index.ts'],
  assumptions: [],
  verification: {
    performed: ['npm run typecheck passed'],
    missing: ['Acceptance criterion not verified by automated checks: wrangler dev starts locally.'],
  },
  risks: [],
};

const implementationJudgment = {
  rubric: 'implementation',
  overall: 0.65,
  overall_uncapped: 0.65,
  threshold: 0.7,
  passed: false,
  gates: [],
  gates_failed: [],
  dimensions_scored: [
    { id: 'smallest_coherent_change', score: 4, weight: 8, evidence: 'ok' },
    { id: 'implementation_note_quality', score: 3, weight: 5, evidence: 'honest but thin' },
  ],
  dimensions_not_scored: [],
  dimensions_missing: [],
  remediation: [],
};

test('non-actionable implementation judgment can proceed to release-gate verification', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('actionable implementation remediation still blocks the fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: {
        ...implementationJudgment,
        remediation: ['DIMENSION implementation_note_quality scored 2/5. Add missing checks.'],
      },
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
});
