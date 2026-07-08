import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDeliveryTaskPlan, formatSmellAuditReport } from '../../src/mastra/delivery-engine/smell-audit';
import type { TaskPlan } from '../../src/mastra/delivery-engine/workflow-schemas';

function minimalTaskPlan(task: TaskPlan['tasks'][number]): TaskPlan {
  return {
    artifact_type: 'task-plan',
    scope: 'smell audit fixture',
    tasks: [task],
    technology_decisions: [],
    open_decisions: [],
    risks: [],
  };
}

test('smell audit reports behavior criteria as unverified instead of file-evidence verified', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-smell-file-evidence-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/validation.ts'),
    [
      'export function validateRunRequest() {',
      '  const payload = { json: true, compatible: true, error: "validation_error" };',
      '  const providerAdapters = "not called";',
      '  return { consistent: true, payload, providerAdapters };',
      '}',
      '',
    ].join('\n'),
  );

  const report = auditDeliveryTaskPlan({
    repoPath,
    taskPlan: minimalTaskPlan({
      id: 'T01',
      owner: 'engineer',
      deliverable: 'Validation helpers',
      depends_on: [],
      owned_surfaces: ['src/validation.ts'],
      acceptance_criteria: [
        'src/validation.ts validation helpers return consistent JSON-compatible error payloads and do not call provider adapters.',
      ],
    }),
  });

  assert.equal(report.summary.genericFileEvidence, 0);
  assert.equal(report.summary.behaviorByFileEvidence, 0);
  assert.equal(report.summary.behaviorUnverified, 1);
  assert.equal(report.smells[0].smell, 'behavior_unverified');
});

test('smell audit treats provider behavior test output as command evidence', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-smell-command-evidence-'));
  const report = auditDeliveryTaskPlan({
    repoPath,
    taskPlan: minimalTaskPlan({
      id: 'T01',
      owner: 'engineer',
      deliverable: 'Provider behavior tests',
      depends_on: [],
      owned_surfaces: ['test/provider-adapters.test.ts'],
      acceptance_criteria: [
        'Provider adapter failures normalize to provider_error and timeout_or_network_error client-safe RunResult values.',
      ],
    }),
    verification: {
      performed: [
        'npm run test passed: test/provider-adapters.test.ts > provider adapter failures normalize to provider_error and timeout_or_network_error client-safe RunResult values',
      ],
      missing: [],
    },
  });

  assert.equal(report.summary.command, 1);
  assert.equal(report.summary.behaviorByFileEvidence, 0);
  assert.equal(report.summary.behaviorUnverified, 0);
  assert.equal(report.summary.smellCount, 0);
});

test('smell audit report is stable enough for run-journal use', () => {
  const report = formatSmellAuditReport({
    repoPath: '/tmp/example',
    taskPlanPath: '/tmp/example/.delivery/artifacts/task-plan.revision-1.json',
    summary: {
      tasks: 1,
      contracts: 1,
      structured: 0,
      command: 0,
      genericFileEvidence: 1,
      unverified: 0,
      behaviorCriteria: 1,
      behaviorByFileEvidence: 1,
      behaviorUnverified: 0,
      smellCount: 1,
    },
    taskRows: [
      {
        task: 'T01',
        title: 'Example',
        contracts: 1,
        genericFileEvidence: 1,
        unverified: 0,
        behaviorByFileEvidence: 1,
        behaviorUnverified: 0,
      },
    ],
    smells: [
      {
        task: 'T01',
        title: 'Example',
        id: 'T01-AC01',
        criterion: 'The route returns JSON.',
        status: 'verified',
        evidenceKind: 'generic_file_evidence',
        behaviorCriterion: true,
        smell: 'behavior_by_file_evidence',
        evidence: ['file evidence covered 4/4 acceptance tokens in src/index.ts'],
        gaps: [],
      },
    ],
  });

  assert.match(report, /Behavior by file evidence: 1/);
  assert.match(report, /T01 T01-AC01 behavior_by_file_evidence/);
});
