import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { stageSlice, type DeliveryEvent } from '../checks';
import { readDeliveryEvents } from '../state';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  readDeliveryEventsState,
} from '../state-service';

export class DeliveryStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = 'DeliveryStageTimeoutError';
  }
}

export class DeliveryNoToolCallTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no tool calls after ${timeoutMs}ms`);
    this.name = 'DeliveryNoToolCallTimeoutError';
  }
}

export class DeliveryPostWriteQuietTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no progress for ${timeoutMs}ms after a workspace write`);
    this.name = 'DeliveryPostWriteQuietTimeoutError';
  }
}

export class DeliveryReadBudgetExceededError extends DeliveryStageTimeoutError {
  constructor(
    stage: string,
    readonly blockCount: number,
  ) {
    super(stage, 0, `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`);
    this.name = 'DeliveryReadBudgetExceededError';
  }
}

export async function stageHasToolUse({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return stageSlice(readDeliveryEvents(repoPath), stage).some((event) => event.type === 'tool_use');
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return stageSlice(events, stage).some((event) => event.type === 'tool_use');
}

const writeToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

export function latestSuccessfulWorkspaceWriteEventTimestamp(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const scoped = stageSlice(events, stage);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const event = scoped[index];
    if (event.type !== 'tool_use' || event.ok !== true || typeof event.tool !== 'string') continue;
    if (!writeToolNames.has(event.tool)) continue;

    const timestamp = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

const readBudgetExceededPattern = /already used \d+ read\/list tool calls before any write/i;

export function readBudgetBlockedToolCount(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  return stageSlice(events, stage).filter(
    (event) => event.type === 'tool_use' && event.ok === false && readBudgetExceededPattern.test(String(event.error ?? '')),
  ).length;
}

export async function latestStageSuccessfulWriteTimestamp({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return latestSuccessfulWorkspaceWriteEventTimestamp(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return latestSuccessfulWorkspaceWriteEventTimestamp(events, { stage });
}

export async function stageReadBudgetBlockedToolCount({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return readBudgetBlockedToolCount(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to Mastra storage when local projection is unavailable.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return readBudgetBlockedToolCount(events, { stage });
}

export async function runWithDeliveryStageTimeout<T>({
  repoPath,
  mastra,
  stage,
  timeoutMs,
  firstToolTimeoutMs,
  firstToolCheck,
  postWriteQuietTimeoutMs,
  latestWriteCheck,
  readBudgetBlockLimit,
  readBudgetBlockCheck,
  operation,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  timeoutMs: number;
  firstToolTimeoutMs?: number;
  firstToolCheck?: () => Promise<boolean>;
  postWriteQuietTimeoutMs?: number;
  latestWriteCheck?: () => Promise<number | undefined>;
  readBudgetBlockLimit?: number;
  readBudgetBlockCheck?: () => Promise<number>;
  operation: (abortSignal: AbortSignal) => Promise<T>;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstToolTimer: ReturnType<typeof setTimeout> | undefined;
  let postWriteQuietTimer: ReturnType<typeof setInterval> | undefined;
  let readBudgetTimer: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(`Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
      reject(new DeliveryStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  const firstToolTimeout =
    firstToolTimeoutMs && firstToolCheck
      ? new Promise<never>((_, reject) => {
          firstToolTimer = setTimeout(() => {
            firstToolCheck()
              .then((hasToolUse) => {
                if (hasToolUse) return;
                controller.abort(`Delivery stage "${stage}" made no tool calls after ${firstToolTimeoutMs}ms`);
                reject(new DeliveryNoToolCallTimeoutError(stage, firstToolTimeoutMs));
              })
              .catch(() => undefined);
          }, firstToolTimeoutMs);
          firstToolTimer.unref?.();
        })
      : undefined;
  const postWriteQuietTimeout =
    postWriteQuietTimeoutMs && latestWriteCheck
      ? new Promise<never>((_, reject) => {
          const pollMs = Math.min(5_000, postWriteQuietTimeoutMs);
          postWriteQuietTimer = setInterval(() => {
            latestWriteCheck()
              .then((latestWriteAt) => {
                if (!latestWriteAt) return;
                if (Date.now() - latestWriteAt < postWriteQuietTimeoutMs) return;

                controller.abort(
                  `Delivery stage "${stage}" made no progress for ${postWriteQuietTimeoutMs}ms after a workspace write`,
                );
                reject(new DeliveryPostWriteQuietTimeoutError(stage, postWriteQuietTimeoutMs));
              })
              .catch(() => undefined);
          }, pollMs);
          postWriteQuietTimer.unref?.();
        })
      : undefined;
  const readBudgetExceeded =
    readBudgetBlockLimit && readBudgetBlockCheck
      ? new Promise<never>((_, reject) => {
          readBudgetTimer = setInterval(() => {
            readBudgetBlockCheck()
              .then((blockCount) => {
                if (blockCount < readBudgetBlockLimit) return;
                controller.abort(
                  `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`,
                );
                reject(new DeliveryReadBudgetExceededError(stage, blockCount));
              })
              .catch(() => undefined);
          }, 2_000);
          readBudgetTimer.unref?.();
        })
      : undefined;

  const work = operation(controller.signal);
  work.catch(() => undefined);

  try {
    return await Promise.race([
      work,
      timeout,
      ...(firstToolTimeout ? [firstToolTimeout] : []),
      ...(postWriteQuietTimeout ? [postWriteQuietTimeout] : []),
      ...(readBudgetExceeded ? [readBudgetExceeded] : []),
    ]);
  } catch (error) {
    if (error instanceof DeliveryStageTimeoutError) {
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event:
          error instanceof DeliveryNoToolCallTimeoutError
            ? { type: 'stage_no_tool_timeout', stage, timeout_ms: error.timeoutMs }
            : error instanceof DeliveryPostWriteQuietTimeoutError
              ? { type: 'stage_post_write_quiet_timeout', stage, timeout_ms: error.timeoutMs }
              : error instanceof DeliveryReadBudgetExceededError
                ? { type: 'stage_read_budget_exceeded', stage, blocked_reads: error.blockCount }
                : { type: 'stage_timeout', stage, timeout_ms: error.timeoutMs },
      }).catch(() => undefined);
      await endDeliveryStageState({ repoPath, stage, reason: 'max_turns', mastra }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (firstToolTimer) clearTimeout(firstToolTimer);
    if (postWriteQuietTimer) clearInterval(postWriteQuietTimer);
    if (readBudgetTimer) clearInterval(readBudgetTimer);
  }
}
