import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    surfaces: ['workers/tally.js'],
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

test('delivery state normalizes document paths inside repo and rejects outside documents', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-state-paths-'));
  mkdirSync(join(repoPath, 'docs'));
  writeFileSync(join(repoPath, 'docs', 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'docs', 'spec.md'), '# Spec\n');

  const run = initializeDeliveryRun({
    repoPath,
    visionPath: join(repoPath, 'docs', 'vision.md'),
    specPath: 'docs/spec.md',
  });
  assert.equal(run.vision, 'docs/vision.md');
  assert.equal(run.spec, 'docs/spec.md');

  const blockedRepo = mkdtempSync(join(tmpdir(), 'delivery-state-paths-blocked-'));
  const outside = join(tmpdir(), `outside-spec-${Date.now()}.md`);
  writeFileSync(join(blockedRepo, 'vision.md'), '# Vision\n');
  writeFileSync(outside, '# Spec\n');

  assert.throws(
    () => initializeDeliveryRun({ repoPath: blockedRepo, visionPath: 'vision.md', specPath: outside }),
    /spec file must be inside repoPath/,
  );
});

test('delivery artifact writes are confined to .delivery/artifacts', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-artifact-containment-'));

  assert.throws(
    () => writeDeliveryArtifact({ repoPath, artifactPath: '../escape.json', artifact: { ok: false } }),
    /delivery artifact path must stay inside repoPath/,
  );
  assert.throws(
    () => writeDeliveryArtifact({ repoPath, artifactPath: '.delivery/run.json', artifact: { ok: false } }),
    /delivery artifact path must be under \.delivery\/artifacts\//,
  );

  const insidePath = join(repoPath, '.delivery/artifacts/direct.json');
  const result = writeDeliveryArtifact({
    repoPath,
    artifactPath: insidePath,
    artifact: { ok: true },
  });

  assert.equal(result.path, '.delivery/artifacts/direct.json');
  assert.equal(existsSync(insidePath), true);
});
