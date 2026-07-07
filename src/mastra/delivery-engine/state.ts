import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { roleBoundaries, type DeliveryRole } from './boundaries';
import type { DeliveryEvent } from './checks';
import { repoRelativeExistingFile } from './paths';

export type DeliveryTaskStatus = 'pending' | 'building' | 'judging' | 'complete' | 'stuck' | 'blocked';
export type DeliveryRunStatus = 'running' | 'complete' | 'failed' | 'stuck';
export type DeliveryStageEndReason = 'complete_stage' | 'escalation' | 'max_turns' | 'failed';

export type DeliveryRun = {
  run_id: string;
  started_at: string;
  finished_at?: string;
  vision: string;
  spec: string;
  status: DeliveryRunStatus;
  stage: string;
  tasks: Record<string, { status: DeliveryTaskStatus; retries: number; owner?: string; note?: string }>;
  artifacts: Record<string, string>;
  judgments: Array<{ subject: string; rubric: string; overall?: number; passed?: boolean; path: string }>;
  stuck: Array<{ task: string; note: string }>;
};

export type DeliveryBoundary = {
  role: DeliveryRole;
  stage: string;
  owned: readonly string[];
  forbidden: readonly string[];
  task_surfaces?: string[];
};

const deliveryDir = (repoPath: string) => join(resolve(repoPath), '.delivery');
const runPath = (repoPath: string) => join(deliveryDir(repoPath), 'run.json');
const eventsPath = (repoPath: string) => join(deliveryDir(repoPath), 'events.jsonl');
const boundaryPath = (repoPath: string) => join(deliveryDir(repoPath), 'boundary.json');
const deliveryArtifactsDir = (repoPath: string) => join(deliveryDir(repoPath), 'artifacts');

const ensureDeliveryDirs = (repoPath: string) => {
  mkdirSync(join(deliveryArtifactsDir(repoPath), 'judgments'), { recursive: true });
};

function deliveryArtifactTarget(repoPath: string, artifactPath: string) {
  const repoRoot = resolve(repoPath);
  const fullPath = resolve(repoRoot, artifactPath);
  const normalizedArtifactPath = relative(repoRoot, fullPath).replaceAll('\\', '/');

  if (
    !normalizedArtifactPath ||
    normalizedArtifactPath.startsWith('../') ||
    normalizedArtifactPath === '..' ||
    isAbsolute(normalizedArtifactPath)
  ) {
    throw new Error('delivery artifact path must stay inside repoPath');
  }

  if (!normalizedArtifactPath.startsWith('.delivery/artifacts/')) {
    throw new Error('delivery artifact path must be under .delivery/artifacts/');
  }

  return { fullPath, artifactPath: normalizedArtifactPath };
}

export function createDeliveryRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function readDeliveryRun(repoPath: string): DeliveryRun {
  const file = runPath(repoPath);
  if (!existsSync(file)) throw new Error('no active delivery run found');
  return JSON.parse(readFileSync(file, 'utf8')) as DeliveryRun;
}

function writeDeliveryRun(repoPath: string, run: DeliveryRun) {
  ensureDeliveryDirs(repoPath);
  writeFileSync(runPath(repoPath), JSON.stringify(run, null, 2));
}

export function writeDeliveryRunProjection(repoPath: string, run: DeliveryRun) {
  writeDeliveryRun(repoPath, run);
}

export function writeDeliveryEventsProjection(repoPath: string, events: DeliveryEvent[]) {
  ensureDeliveryDirs(repoPath);
  writeFileSync(eventsPath(repoPath), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
}

export function writeDeliveryBoundaryProjection(repoPath: string, boundary: DeliveryBoundary) {
  ensureDeliveryDirs(repoPath);
  writeFileSync(boundaryPath(repoPath), JSON.stringify(boundary, null, 2));
}

export function removeDeliveryBoundaryProjection(repoPath: string) {
  rmSync(boundaryPath(repoPath), { force: true });
}

export function timestampDeliveryEvent(event: DeliveryEvent) {
  return {
    ts: new Date().toISOString(),
    source: 'mastra',
    ...event,
  } as DeliveryEvent;
}

export function appendDeliveryEvent(repoPath: string, event: DeliveryEvent) {
  ensureDeliveryDirs(repoPath);
  appendFileSync(eventsPath(repoPath), JSON.stringify(timestampDeliveryEvent(event)) + '\n');
}

export function readDeliveryEvents(repoPath: string): DeliveryEvent[] {
  const file = eventsPath(repoPath);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DeliveryEvent);
}

export function initializeDeliveryRun({
  repoPath,
  visionPath,
  specPath,
}: {
  repoPath: string;
  visionPath: string;
  specPath: string;
}) {
  const repo = resolve(repoPath);
  const vision = repoRelativeExistingFile({ repoPath: repo, path: visionPath, label: 'vision' });
  const spec = repoRelativeExistingFile({ repoPath: repo, path: specPath, label: 'spec' });
  const existingPath = runPath(repo);

  if (existsSync(existingPath)) {
    const existing = JSON.parse(readFileSync(existingPath, 'utf8')) as DeliveryRun;
    if (existing.status === 'running') {
      throw new Error(`a delivery run is already active (started ${existing.started_at})`);
    }
  }

  const run: DeliveryRun = {
    run_id: createDeliveryRunId(),
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

  writeDeliveryRun(repo, run);
  appendDeliveryEvent(repo, { type: 'run_init', run_id: run.run_id, vision, spec });

  return run;
}

export function startDeliveryStage({
  repoPath,
  stage,
  role,
  surfaces,
}: {
  repoPath: string;
  stage: string;
  role: DeliveryRole;
  surfaces?: string[];
}) {
  const repo = resolve(repoPath);
  const boundary: DeliveryBoundary = {
    role,
    stage,
    owned: roleBoundaries[role].owned,
    forbidden: roleBoundaries[role].forbidden,
  };
  if (surfaces?.length) boundary.task_surfaces = surfaces;

  ensureDeliveryDirs(repo);
  writeFileSync(boundaryPath(repo), JSON.stringify(boundary, null, 2));

  const run = readDeliveryRun(repo);
  run.stage = stage;
  writeDeliveryRun(repo, run);
  appendDeliveryEvent(repo, { type: 'stage_start', stage, role });

  return { ok: true, boundary };
}

export function endDeliveryStage({
  repoPath,
  stage,
  reason,
}: {
  repoPath: string;
  stage: string;
  reason: DeliveryStageEndReason;
}) {
  const repo = resolve(repoPath);
  rmSync(boundaryPath(repo), { force: true });
  appendDeliveryEvent(repo, { type: 'stage_end', stage, reason });
  return { ok: true };
}

export function updateDeliveryTask({
  repoPath,
  id,
  status,
  owner,
  note,
  bumpRetries = false,
}: {
  repoPath: string;
  id: string;
  status: DeliveryTaskStatus;
  owner?: string;
  note?: string;
  bumpRetries?: boolean;
}) {
  const run = readDeliveryRun(repoPath);
  const task = run.tasks[id] ?? { status: 'pending' as DeliveryTaskStatus, retries: 0 };
  task.status = status;
  if (bumpRetries) task.retries = (task.retries ?? 0) + 1;
  if (owner) task.owner = owner;
  if (note) task.note = note;
  run.tasks[id] = task;
  if (status === 'stuck' && !run.stuck.some((item) => item.task === id)) {
    run.stuck.push({ task: id, note: note ?? 'no diagnostics recorded' });
  }
  writeDeliveryRun(repoPath, run);
  return { ok: true, task: { id, ...task } };
}

export function recordDeliveryArtifact({
  repoPath,
  type,
  path,
}: {
  repoPath: string;
  type: string;
  path: string;
}) {
  const run = readDeliveryRun(repoPath);
  run.artifacts[type] = path;
  writeDeliveryRun(repoPath, run);
  appendDeliveryEvent(repoPath, { type: 'artifact_write', artifact_type: type, path });
  return { ok: true };
}

export function recordDeliveryJudgment({
  repoPath,
  subject,
  rubric,
  path,
  overall,
  passed,
}: {
  repoPath: string;
  subject: string;
  rubric: string;
  path: string;
  overall?: number;
  passed?: boolean;
}) {
  const run = readDeliveryRun(repoPath);
  run.judgments.push({ subject, rubric, path, overall, passed });
  writeDeliveryRun(repoPath, run);
  return { ok: true };
}

export function finishDeliveryRun({ repoPath, status }: { repoPath: string; status: DeliveryRunStatus }) {
  const run = readDeliveryRun(repoPath);
  run.status = status;
  run.finished_at = new Date().toISOString();
  run.stage = 'done';
  writeDeliveryRun(repoPath, run);
  rmSync(boundaryPath(repoPath), { force: true });
  appendDeliveryEvent(repoPath, { type: 'run_finish', status });
  return { ok: true, status };
}

export function writeDeliveryArtifact({
  repoPath,
  artifactPath,
  artifact,
}: {
  repoPath: string;
  artifactPath: string;
  artifact: unknown;
}) {
  const target = deliveryArtifactTarget(repoPath, artifactPath);
  const { fullPath } = target;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(artifact, null, 2));
  return { ok: true, path: target.artifactPath };
}

export function getDeliveryRunStatus(repoPath: string) {
  const run = readDeliveryRun(repoPath);
  return {
    run_id: run.run_id,
    status: run.status,
    stage: run.stage,
    tasks: Object.entries(run.tasks).map(([id, task]) => `${id}:${task.status}${task.retries ? `(r${task.retries})` : ''}`),
    stuck: run.stuck,
    judgments: run.judgments.length,
    artifacts: Object.keys(run.artifacts),
  };
}

export function readDeliveryBoundary(repoPath: string): DeliveryBoundary | undefined {
  const file = boundaryPath(repoPath);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as DeliveryBoundary;
}

export function hasDeliveryDirectory(repoPath: string) {
  return existsSync(deliveryDir(repoPath));
}

export function hasDeliveryRunProjection(repoPath: string) {
  return existsSync(runPath(repoPath));
}
