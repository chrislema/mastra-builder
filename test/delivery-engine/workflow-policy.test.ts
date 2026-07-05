import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  implementationDeterministicRemediation,
  missingOwnedSurfacePaths,
  reusableImplementationArtifactForTask,
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
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-verification-gaps-'));
  writeFileSync(join(repoPath, 'src-existing.ts'), 'export {};\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src-existing.ts', 'src-missing.ts'],
      acceptance_criteria: [
        'TypeScript typecheck passes.',
        'wrangler dev starts the Worker locally without errors.',
        'Worker entry point returns HTTP 200 on GET /health.',
      ],
    },
  ]).tasks;

  const verification = verificationWithAcceptanceGaps({
    repoPath,
    task,
    verification: {
      performed: ['npm run typecheck passed'],
      missing: [],
    },
  });

  assert.deepEqual(verification.performed, ['npm run typecheck passed']);
  assert.deepEqual(verification.missing, [
    'Owned surface missing after implementation: src-missing.ts',
    'Acceptance criterion not verified by automated checks: wrangler dev starts the Worker locally without errors.',
    'Acceptance criterion not verified by automated checks: Worker entry point returns HTTP 200 on GET /health.',
  ]);
});

test('owned surface presence normalizes annotated paths and ignores globs', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-owned-surfaces-'));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo"\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml (triggers section)', 'src/**', 'src/ai/client.ts'],
    },
  ]).tasks;

  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), ['src/ai/client.ts']);
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

test('missing owned surfaces block the non-actionable implementation fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [
        { id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' },
        {
          id: 'owned_surfaces_present',
          check: 'owned_surfaces_present',
          passed: false,
          reason: 'missing owned surfaces: src/ai/client.ts',
        },
      ],
      note: implementationNote,
    }),
    false,
  );
});

test('deterministic implementation blockers produce retry remediation before model judging', () => {
  assert.deepEqual(
    implementationDeterministicRemediation([
      { id: 'owned_surfaces_present', check: 'owned_surfaces_present', passed: false, reason: 'missing owned surfaces: src/ai/client.ts' },
      { id: 'verification_passed', check: 'build_verification_passed', passed: false, reason: 'npm run typecheck failed: TS1128' },
      { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', passed: false, reason: 'bcrypt found' },
    ]),
    [
      'DETERMINISTIC owned_surfaces_present failed: missing owned surfaces: src/ai/client.ts',
      'DETERMINISTIC verification_passed failed: npm run typecheck failed: TS1128',
    ],
  );
});

test('reusable implementation artifacts require passing judgment and present owned surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-artifact-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.deepEqual(reusableImplementationArtifactForTask(repoPath, task), {
    note: {
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    },
    notePath: '.delivery/artifacts/note-T1.a1.json',
    judgment: {
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    },
    judgmentPath: '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json',
    judgeOutputPath: undefined,
    attempt: 1,
  });
});

test('reusable implementation artifacts reject notes outside role ownership', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-boundary-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'public'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'public/index.html'), '<!doctype html>\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['public/index.html'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.equal(reusableImplementationArtifactForTask(repoPath, task), undefined);
});
