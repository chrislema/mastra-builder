import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runDeterministicCheck, type DeliveryEvent } from '../checks';
import type { AggregatedJudgment } from '../judgment';
import { topoOrderTasks } from '../task-plan-dependencies';
import {
  implementationNoteSchema,
  type ImplementationNote,
  type Task,
  type TaskPlan,
} from '../workflow-schemas';
import { workflowStepIntegrationGaps } from './deterministic-gates';
import {
  missingOwnedSurfacePaths,
  taskBoundaryAllowsRepairPath,
  workersAiBindingGaps,
} from './task-boundaries';
import { existingOwnedFiles } from './task-packet';

const implementationWriteTools = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'auto_repair',
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  if (!existsSync(fullPath)) return undefined;
  return JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
}

function buildRoleForTask(task: Task) {
  return (task.owner === 'designer' ? 'designer' : 'engineer') as 'designer' | 'engineer';
}

export function priorStoppedBuildTaskIds({
  taskPlan,
  taskIndex,
  taskStatuses,
}: {
  taskPlan: TaskPlan;
  taskIndex: number;
  taskStatuses: Record<string, { status?: string } | undefined>;
}) {
  return topoOrderTasks(taskPlan.tasks)
    .slice(0, taskIndex)
    .filter((task) => ['stuck', 'blocked'].includes(String(taskStatuses[task.id]?.status)))
    .map((task) => task.id);
}

export function reusableImplementationArtifactForTask(repoPath: string, task: Task) {
  if (process.env.DELIVERY_REUSE_TASK_ARTIFACTS === '0') return undefined;
  if (missingOwnedSurfacePaths(repoPath, task).length) return undefined;
  if (workflowStepIntegrationGaps(repoPath, task).length) return undefined;
  if (workersAiBindingGaps(repoPath, task).length) return undefined;

  const judgmentDir = join(resolve(repoPath), '.delivery/artifacts/judgments');
  if (!existsSync(judgmentDir)) return undefined;

  const prefix = `implementation-${task.id}-a`;
  const candidates = readdirSync(judgmentDir)
    .map((file) => {
      const match = file.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.judgment\\.json$`));
      return match ? { file, attempt: Number(match[1]) } : undefined;
    })
    .filter((candidate): candidate is { file: string; attempt: number } => Boolean(candidate))
    .sort((a, b) => b.attempt - a.attempt);

  for (const candidate of candidates) {
    const judgmentPath = `.delivery/artifacts/judgments/${candidate.file}`;
    const judgment = readJsonArtifact(repoPath, judgmentPath) as Partial<AggregatedJudgment> | undefined;
    if (!judgment?.passed || typeof judgment.overall !== 'number') continue;

    const notePath = `.delivery/artifacts/note-${task.id}.a${candidate.attempt}.json`;
    const note = implementationNoteSchema.safeParse(readJsonArtifact(repoPath, notePath));
    if (!note.success || note.data.task !== task.id) continue;

    const ownership = runDeterministicCheck({
      name: 'file_ownership',
      role: buildRoleForTask(task),
      paths: note.data.files_touched,
    });
    if (!ownership.passed) continue;

    const judgeOutputPath = judgmentPath.replace(/\.judgment\.json$/, '.judge.json');
    return {
      note: note.data,
      notePath,
      judgment,
      judgmentPath,
      judgeOutputPath: existsSync(join(resolve(repoPath), judgeOutputPath)) ? judgeOutputPath : undefined,
      attempt: candidate.attempt,
    };
  }

  return undefined;
}

export function deliveryBuildResumePlan(repoPath: string, taskPlan: TaskPlan) {
  const orderedTasks = topoOrderTasks(taskPlan.tasks);
  const reusableTaskIds: string[] = [];
  const reusableSet = new Set<string>();

  for (const task of orderedTasks) {
    if (!task.depends_on.every((dependency) => reusableSet.has(dependency))) break;
    if (!reusableImplementationArtifactForTask(repoPath, task)) break;
    reusableTaskIds.push(task.id);
    reusableSet.add(task.id);
  }

  const nextTask = orderedTasks[reusableTaskIds.length];
  return {
    reusableTaskIds,
    resumeAfterTaskId: reusableTaskIds.at(-1),
    nextTaskId: nextTask?.id,
    totalTasks: orderedTasks.length,
  };
}

export function deliveryBuildResumeReason(plan: ReturnType<typeof deliveryBuildResumePlan>) {
  if (!plan.reusableTaskIds.length) return undefined;
  const resumeAfter = plan.resumeAfterTaskId ?? 'none';
  const nextTask = plan.nextTaskId ?? 'release gate';
  return `Resume cursor: ${plan.reusableTaskIds.length}/${plan.totalTasks} implementation task(s) already have passing artifacts; resume after ${resumeAfter}, next ${nextTask}.`;
}

export function implementationFilesTouched({
  repoPath,
  stage,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  task: Task;
  events: DeliveryEvent[];
}) {
  const stageEvents = implementationStageEvents(events, stage);
  const written = stageEvents
    .filter((event) => event.ok !== false && implementationWriteTools.has(String(event.tool)))
    .flatMap((event) => {
      const paths = event.paths ?? [];
      if (String(event.tool) !== 'auto_repair') return paths;
      return paths.filter((path) => taskBoundaryAllowsRepairPath(repoPath, task, path));
    })
    .filter((path) => path && !path.startsWith('.delivery/'));

  return Array.from(new Set(written.length ? written : existingOwnedFiles(repoPath, task)));
}

function implementationStageEvents(events: DeliveryEvent[], stage: string) {
  const stageEvents: DeliveryEvent[] = [];
  let active = false;

  for (const event of events) {
    if (event.type === 'stage_start' && event.stage === stage) {
      active = true;
      stageEvents.push(event);
      continue;
    }

    if (!active) continue;

    stageEvents.push(event);
    if (event.type === 'stage_end' && event.stage === stage) {
      active = false;
    }
  }

  return stageEvents;
}
