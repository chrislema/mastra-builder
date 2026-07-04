import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  finishDeliveryRun,
  getDeliveryRunStatus,
  initializeDeliveryRun,
  readDeliveryEvents,
  readDeliveryRun,
  recordDeliveryArtifact,
  recordDeliveryJudgment,
  startDeliveryStage,
  updateDeliveryTask,
  writeDeliveryArtifact,
} from '../../src/mastra/delivery-engine/state.ts';

test('delivery state lifecycle writes inspectable run state and events', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-state-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');

  const run = initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });
  assert.equal(run.status, 'running');
  assert.equal(readDeliveryRun(repoPath).stage, 'readout');

  const boundary = startDeliveryStage({
    repoPath,
    stage: 'build:T1',
    role: 'engineer',
    surfaces: ['functions/api/login.js'],
  });
  assert.equal(boundary.boundary.role, 'engineer');
  assert.equal(readDeliveryRun(repoPath).stage, 'build:T1');

  updateDeliveryTask({ repoPath, id: 'T1', status: 'building', owner: 'engineer' });
  updateDeliveryTask({ repoPath, id: 'T1', status: 'complete', owner: 'engineer' });
  writeDeliveryArtifact({
    repoPath,
    artifactPath: '.delivery/artifacts/note-T1.json',
    artifact: { artifact_type: 'implementation-note', task: 'T1' },
  });
  recordDeliveryArtifact({ repoPath, type: 'note-T1', path: '.delivery/artifacts/note-T1.json' });
  recordDeliveryJudgment({
    repoPath,
    subject: '.delivery/artifacts/note-T1.json',
    rubric: 'implementation',
    path: '.delivery/artifacts/judgments/implementation-T1.json',
    overall: 0.9,
    passed: true,
  });

  const status = getDeliveryRunStatus(repoPath);
  assert.deepEqual(status.tasks, ['T1:complete']);
  assert.equal(status.judgments, 1);
  assert.deepEqual(status.artifacts, ['note-T1']);

  finishDeliveryRun({ repoPath, status: 'complete' });
  assert.equal(readDeliveryRun(repoPath).status, 'complete');
  assert.equal(readDeliveryEvents(repoPath).some((event) => event.type === 'run_finish'), true);
});
