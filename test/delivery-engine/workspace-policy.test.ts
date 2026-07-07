import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import {
  deliveryProjectRootForSkills,
  deliveryReadToolBlockReason,
  deliverySkillRoot,
  deliveryWorkspace,
  deliveryWorkspaceSkillPaths,
} from '../../src/mastra/delivery-engine/workspace.ts';
import { appendDeliveryEvent, initializeDeliveryRun, startDeliveryStage } from '../../src/mastra/delivery-engine/state.ts';

function initializedRepo(prefix: string) {
  const repoPath = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });
  return repoPath;
}

test('workspace skills resolve from the project root when cwd changes', async () => {
  const originalCwd = process.cwd();

  process.chdir(tmpdir());
  try {
    assert.equal(deliveryProjectRootForSkills(), resolve(originalCwd));
    assert.equal(deliveryWorkspaceSkillPaths[0], deliverySkillRoot);

    const skills = await deliveryWorkspace.skills?.list();
    assert.ok(skills);
    assert.equal(skills.length, 17);
    assert.ok(skills.some((skill) => skill.name === 'select-cloudflare-components'));
  } finally {
    process.chdir(originalCwd);
  }
});

test('workspace read policy blocks reading directories as files', () => {
  const repoPath = initializedRepo('delivery-workspace-dir-read-');
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  startDeliveryStage({
    repoPath,
    stage: 'build:T1',
    role: 'engineer',
    surfaces: ['migrations/0001_schema.sql'],
  });

  assert.match(
    deliveryReadToolBlockReason({
      repoPath,
      workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
      relativePaths: ['migrations'],
    }) ?? '',
    /is a directory/,
  );
});

test('workspace read policy limits pre-write read loops in build stages', () => {
  const repoPath = initializedRepo('delivery-workspace-read-budget-');
  startDeliveryStage({
    repoPath,
    stage: 'build:T1',
    role: 'engineer',
    surfaces: ['src/index.ts'],
  });

  for (let index = 0; index < 6; index += 1) {
    appendDeliveryEvent(repoPath, {
      type: 'tool_use',
      stage: 'build:T1',
      tool: WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
      ok: true,
      paths: [`src/file-${index}.ts`],
    });
  }

  assert.match(
    deliveryReadToolBlockReason({
      repoPath,
      workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
      relativePaths: ['src'],
    }) ?? '',
    /already used 6 read\/list tool calls/,
  );

  appendDeliveryEvent(repoPath, {
    type: 'tool_use',
    stage: 'build:T1',
    tool: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
    ok: true,
    paths: ['src/index.ts'],
  });

  assert.equal(
    deliveryReadToolBlockReason({
      repoPath,
      workspaceToolName: WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
      relativePaths: ['src'],
    }),
    undefined,
  );
});
