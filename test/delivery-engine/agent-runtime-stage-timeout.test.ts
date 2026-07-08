import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import {
  DeliveryStageTimeoutError,
  latestSuccessfulWorkspaceWriteEventTimestamp,
  readBudgetBlockedToolCount,
  runWithDeliveryStageTimeout,
} from '../../src/mastra/delivery-engine/agent-runtime/stage-timeout';

test('runWithDeliveryStageTimeout returns completed work', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stage-timeout-ok-'));
  const result = await runWithDeliveryStageTimeout({
    repoPath,
    mastra: undefined,
    stage: 'build:T1',
    timeoutMs: 1_000,
    operation: async () => 'ok',
  });

  assert.equal(result, 'ok');
});

test('runWithDeliveryStageTimeout throws a stage timeout error', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stage-timeout-fail-'));

  await assert.rejects(
    runWithDeliveryStageTimeout({
      repoPath,
      mastra: undefined,
      stage: 'build:T1',
      timeoutMs: 1,
      operation: () => new Promise(() => undefined),
    }),
    DeliveryStageTimeoutError,
  );
});

test('stage timeout helpers read write and read-budget events by stage', () => {
  const events = [
    { type: 'stage_start', stage: 'build:T1' },
    {
      type: 'tool_use',
      tool: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      ok: true,
      ts: '2026-07-08T00:00:00.000Z',
    },
    { type: 'stage_end', stage: 'build:T1', reason: 'complete_stage' },
    { type: 'stage_start', stage: 'build:T2' },
    {
      type: 'tool_use',
      tool: WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      ok: true,
      ts: '2026-07-08T00:00:02.000Z',
    },
    {
      type: 'tool_use',
      ok: false,
      error: 'Already used 3 read/list tool calls before any write.',
    },
  ] as any[];

  assert.equal(
    latestSuccessfulWorkspaceWriteEventTimestamp(events, { stage: 'build:T1' }),
    Date.parse('2026-07-08T00:00:00.000Z'),
  );
  assert.equal(
    latestSuccessfulWorkspaceWriteEventTimestamp(events, { stage: 'build:T2' }),
    Date.parse('2026-07-08T00:00:02.000Z'),
  );
  assert.equal(readBudgetBlockedToolCount(events, { stage: 'build:T2' }), 1);
});
