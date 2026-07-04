import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dependencyGraphAcyclic,
  fileOwnership,
  harnessRunBeforeFindings,
  planSchemaComplete,
  ranCodeBeforeComplete,
  releaseBlockersZero,
  tierOrderCheck,
} from '../../src/mastra/delivery-engine/checks.ts';

test('planSchemaComplete requires task rows to be executable', () => {
  assert.equal(
    planSchemaComplete({
      artifact_type: 'task-plan',
      tasks: [
        {
          id: 'T1',
          owner: 'engineer',
          deliverable: 'Implement login endpoint',
          depends_on: [],
          acceptance_criteria: ['valid credentials return 200'],
          owned_surfaces: ['workers/auth.js'],
        },
      ],
    }).passed,
    true,
  );

  const missing = planSchemaComplete({
    artifact_type: 'task-plan',
    tasks: [{ id: 'T1', owner: 'engineer', deliverable: '', depends_on: [] }],
  });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /deliverable/);

  const invalidOwner = planSchemaComplete({
    artifact_type: 'task-plan',
    tasks: [
      {
        id: 'T1',
        owner: 'tester',
        deliverable: 'Write tests',
        depends_on: [],
        acceptance_criteria: ['release gate covers the changed surface'],
        owned_surfaces: ['tests/login.spec.ts'],
      },
    ],
  });
  assert.equal(invalidOwner.passed, false);
  assert.match(invalidOwner.reason, /not executable by the build loop/);
});

test('dependencyGraphAcyclic rejects unknown dependencies and cycles', () => {
  assert.equal(
    dependencyGraphAcyclic({
      tasks: [
        { id: 'T1', depends_on: [] },
        { id: 'T2', depends_on: ['T1'] },
      ],
    }).passed,
    true,
  );

  assert.equal(dependencyGraphAcyclic({ tasks: [{ id: 'T1', depends_on: ['missing'] }] }).passed, false);
  assert.equal(
    dependencyGraphAcyclic({
      tasks: [
        { id: 'T1', depends_on: ['T2'] },
        { id: 'T2', depends_on: ['T1'] },
      ],
    }).passed,
    false,
  );
});

test('releaseBlockersZero fails closed for deployable gates', () => {
  assert.equal(releaseBlockersZero({ decision: 'pass', blockers: [], critical_areas: [] }).passed, true);
  assert.equal(releaseBlockersZero({ decision: 'pass', blockers: ['auth missing'], critical_areas: [] }).passed, false);
  assert.equal(
    releaseBlockersZero({ decision: 'fail', blockers: [], critical_areas: [] }, { mode: 'deployable' }).passed,
    false,
  );
});

test('tierOrderCheck enforces required tiers for pre-deployment', () => {
  assert.equal(
    tierOrderCheck({
      event_type: 'pre_deployment',
      tiers: [
        { tier: 'smoke', status: 'passed' },
        { tier: 'api', status: 'passed' },
        { tier: 'e2e', status: 'passed' },
        { tier: 'full_matrix', status: 'passed' },
      ],
    }).passed,
    true,
  );

  const skipped = tierOrderCheck({
    event_type: 'pre_deployment',
    tiers: [
      { tier: 'smoke', status: 'passed' },
      { tier: 'api', status: 'skipped' },
      { tier: 'e2e', status: 'passed' },
      { tier: 'full_matrix', status: 'passed' },
    ],
  });
  assert.equal(skipped.passed, false);
  assert.match(skipped.reason, /api/);

  assert.equal(
    tierOrderCheck({
      event_type: 'pre_deployment',
      tiers: [
        { tier: 'smoke', status: 'passed' },
        { tier: 'api', status: 'not_required' },
        { tier: 'e2e', status: 'not_required' },
        { tier: 'full_matrix', status: 'not_required' },
      ],
    }).passed,
    true,
  );
});

test('fileOwnership follows delivery role boundaries', () => {
  assert.equal(fileOwnership({ role: 'engineer', paths: ['workers/auth.js'] }).passed, true);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['package.json', 'src/app.js'] }).passed, true);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['migrations/0001_links.sql'] }).passed, true);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['wrangler.jsonc'] }).passed, true);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['server/index.js'] }).passed, false);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['api/login.js'] }).passed, false);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['src/App.tsx'] }).passed, false);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['next.config.js'] }).passed, false);
  assert.equal(fileOwnership({ role: 'engineer', paths: ['public/index.html'] }).passed, false);
  assert.equal(fileOwnership({ role: 'designer', paths: ['src/ui/login.js', 'src/ui/login.css'] }).passed, true);
  assert.equal(fileOwnership({ role: 'designer', paths: ['wrangler.jsonc'] }).passed, false);
  assert.equal(fileOwnership({ role: 'designer', paths: ['src/components/Login.tsx'] }).passed, false);
  assert.equal(fileOwnership({ role: 'designer', paths: ['src/api/login.ts'] }).passed, false);
  assert.equal(fileOwnership({ role: 'tester', paths: ['vitest.config.ts'] }).passed, true);
  assert.equal(fileOwnership({ role: 'tester', paths: ['src/app.ts'] }).passed, false);
  assert.equal(fileOwnership({ role: 'planner', paths: ['src/app.ts'] }).passed, false);
});

test('ranCodeBeforeComplete recognizes Mastra workspace command execution', () => {
  const events = [
    { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
    { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_execute_command', ok: true },
    { type: 'stage_end', stage: 'build:T1', reason: 'complete_stage' },
  ];
  assert.equal(ranCodeBeforeComplete(events, { stage: 'build:T1' }).passed, true);
  assert.equal(
    ranCodeBeforeComplete(
      [
        { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
        { type: 'stage_end', stage: 'build:T1', reason: 'complete_stage' },
      ],
      { stage: 'build:T1' },
    ).passed,
    false,
  );
});

test('harnessRunBeforeFindings fails when release evidence is written before running code', () => {
  assert.equal(
    harnessRunBeforeFindings(
      [
        { type: 'stage_start', stage: 'test:a1', role: 'tester' },
        { type: 'artifact_write', stage: 'test:a1', artifact_type: 'release-gate' },
        { type: 'tool_use', stage: 'test:a1', tool: 'mastra_workspace_execute_command', ok: true },
        { type: 'stage_end', stage: 'test:a1', reason: 'complete_stage' },
      ],
      { stage: 'test:a1' },
    ).passed,
    false,
  );
});
