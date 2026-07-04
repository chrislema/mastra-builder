import { resolve } from 'node:path';
import { roleBoundaries, type DeliveryRole } from './boundaries';
import type { DeliveryEvent } from './checks';
import { repoRelativeExistingFile } from './paths';
import {
  getDeliveryObservabilityStore,
  persistDeliverySnapshotToMastraStorage,
  readDeliveryRunStatusWithMastra,
  readDeliverySnapshotFromMastraStorage,
  type DeliveryRunStatusSummary,
  type DeliveryStateSnapshot,
  type MastraLike,
} from './observability';
import {
  hasDeliveryDirectory,
  readDeliveryEvents,
  readDeliveryRun,
  removeDeliveryBoundaryProjection,
  timestampDeliveryEvent,
  writeDeliveryBoundaryProjection,
  writeDeliveryEventsProjection,
  writeDeliveryRunProjection,
  type DeliveryBoundary,
  type DeliveryRun,
  type DeliveryRunStatus,
  type DeliveryTaskStatus,
} from './state';

async function readDeliverySnapshot({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}): Promise<DeliveryStateSnapshot> {
  const store = await getDeliveryObservabilityStore(mastra);
  const stored = store ? await readDeliverySnapshotFromMastraStorage({ store, repoPath }) : undefined;
  if (stored) return stored;
  if (hasDeliveryDirectory(repoPath)) return { run: readDeliveryRun(repoPath), events: readDeliveryEvents(repoPath) };
  throw new Error('no active delivery run found');
}

async function persistDeliverySnapshot({
  repoPath,
  mastra,
  run,
  events,
}: DeliveryStateSnapshot & {
  repoPath: string;
  mastra?: MastraLike;
}) {
  const store = await getDeliveryObservabilityStore(mastra);
  if (store) await persistDeliverySnapshotToMastraStorage({ repoPath, run, events, store });
  writeDeliveryRunProjection(repoPath, run);
  writeDeliveryEventsProjection(repoPath, events);
}

const withEvent = (events: DeliveryEvent[], event: DeliveryEvent) => [...events, timestampDeliveryEvent(event)];

function statusFromRun(run: DeliveryRun): DeliveryRunStatusSummary {
  return {
    run_id: run.run_id,
    status: run.status,
    stage: run.stage,
    tasks: Object.entries(run.tasks).map(
      ([id, task]) => `${id}:${task.status}${task.retries ? `(r${task.retries})` : ''}`,
    ),
    stuck: run.stuck,
    judgments: run.judgments.length,
    artifacts: Object.keys(run.artifacts),
  };
}

export async function readDeliveryRunState({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  return (await readDeliverySnapshot({ repoPath: resolve(repoPath), mastra })).run;
}

export async function readDeliveryEventsState({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  return (await readDeliverySnapshot({ repoPath: resolve(repoPath), mastra })).events;
}

export async function initializeDeliveryRunState({
  repoPath,
  visionPath,
  specPath,
  mastra,
}: {
  repoPath: string;
  visionPath: string;
  specPath: string;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const vision = repoRelativeExistingFile({ repoPath: repo, path: visionPath, label: 'vision' });
  const spec = repoRelativeExistingFile({ repoPath: repo, path: specPath, label: 'spec' });

  const storedStatus = await readDeliveryRunStatusWithMastra({ repoPath: repo, mastra });
  const localRun = storedStatus ? undefined : hasDeliveryDirectory(repo) ? readDeliveryRun(repo) : undefined;
  const existingStatus = storedStatus ?? localRun;
  if (existingStatus?.status === 'running') {
    const startedAt = localRun?.started_at ?? 'unknown';
    throw new Error(`a delivery run is already active (started ${startedAt})`);
  }

  const run: DeliveryRun = {
    run_id: `run-${Date.now().toString(36)}`,
    started_at: new Date().toISOString(),
    vision,
    spec,
    status: 'running',
    stage: 'readout',
    tasks: {},
    artifacts: {},
    judgments: [],
    stuck: [],
  };
  const events = withEvent([], { type: 'run_init', run_id: run.run_id, vision, spec });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run, events });
  return run;
}

export async function startDeliveryStageState({
  repoPath,
  stage,
  role,
  surfaces,
  mastra,
}: {
  repoPath: string;
  stage: string;
  role: DeliveryRole;
  surfaces?: string[];
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  const boundary: DeliveryBoundary = {
    role,
    stage,
    owned: roleBoundaries[role].owned,
    forbidden: roleBoundaries[role].forbidden,
  };
  if (surfaces?.length) boundary.task_surfaces = surfaces;

  snapshot.run.stage = stage;
  snapshot.events = withEvent(snapshot.events, { type: 'stage_start', stage, role });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  writeDeliveryBoundaryProjection(repo, boundary);
  return { ok: true, boundary };
}

export async function endDeliveryStageState({
  repoPath,
  stage,
  reason,
  mastra,
}: {
  repoPath: string;
  stage: string;
  reason: 'complete_stage' | 'escalation' | 'max_turns';
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  snapshot.events = withEvent(snapshot.events, { type: 'stage_end', stage, reason });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  removeDeliveryBoundaryProjection(repo);
  return { ok: true };
}

export async function updateDeliveryTaskState({
  repoPath,
  id,
  status,
  owner,
  note,
  bumpRetries = false,
  mastra,
}: {
  repoPath: string;
  id: string;
  status: DeliveryTaskStatus;
  owner?: string;
  note?: string;
  bumpRetries?: boolean;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  const task = snapshot.run.tasks[id] ?? { status: 'pending' as DeliveryTaskStatus, retries: 0 };
  task.status = status;
  if (bumpRetries) task.retries = (task.retries ?? 0) + 1;
  if (owner) task.owner = owner;
  if (note) task.note = note;
  snapshot.run.tasks[id] = task;
  if (status === 'stuck' && !snapshot.run.stuck.some((item) => item.task === id)) {
    snapshot.run.stuck.push({ task: id, note: note ?? 'no diagnostics recorded' });
  }
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  return { ok: true, task: { id, ...task } };
}

export async function recordDeliveryArtifactState({
  repoPath,
  type,
  path,
  mastra,
}: {
  repoPath: string;
  type: string;
  path: string;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  snapshot.run.artifacts[type] = path;
  snapshot.events = withEvent(snapshot.events, { type: 'artifact_write', artifact_type: type, path });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  return { ok: true };
}

export async function recordDeliveryJudgmentState({
  repoPath,
  subject,
  rubric,
  path,
  overall,
  passed,
  mastra,
}: {
  repoPath: string;
  subject: string;
  rubric: string;
  path: string;
  overall?: number;
  passed?: boolean;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  snapshot.run.judgments.push({ subject, rubric, path, overall, passed });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  return { ok: true };
}

export async function appendDeliveryEventState({
  repoPath,
  event,
  mastra,
}: {
  repoPath: string;
  event: DeliveryEvent;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  snapshot.events = withEvent(snapshot.events, event);
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  return { ok: true };
}

export async function finishDeliveryRunState({
  repoPath,
  status,
  mastra,
}: {
  repoPath: string;
  status: DeliveryRunStatus;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const snapshot = await readDeliverySnapshot({ repoPath: repo, mastra });
  snapshot.run.status = status;
  snapshot.run.finished_at = new Date().toISOString();
  snapshot.run.stage = 'done';
  snapshot.events = withEvent(snapshot.events, { type: 'run_finish', status });
  await persistDeliverySnapshot({ repoPath: repo, mastra, run: snapshot.run, events: snapshot.events });
  removeDeliveryBoundaryProjection(repo);
  return { ok: true, status };
}

export async function getDeliveryRunStatusState({
  repoPath,
  mastra,
}: {
  repoPath: string;
  mastra?: MastraLike;
}) {
  const repo = resolve(repoPath);
  const storedStatus = await readDeliveryRunStatusWithMastra({ repoPath: repo, mastra });
  if (storedStatus) return storedStatus;
  return statusFromRun(readDeliveryRun(repo));
}
