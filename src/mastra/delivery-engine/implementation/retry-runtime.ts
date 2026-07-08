import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import {
  fileOwnership,
  matchesAny,
  normalizeDeliveryPathReference,
  stageSlice,
  type DeliveryEvent,
} from '../checks';
import {
  buildTimeoutRemediation as buildTimeoutRemediationForTaskId,
  canSalvageTimedOutBuildAttempt as canSalvageTimedOutBuildAttemptBase,
  implementationFailureClass as implementationFailureClassBase,
  implementationRetryMode as implementationRetryModeBase,
  implementationToolChoiceForRetryMode as implementationToolChoiceForRetryModeBase,
  outOfPlanVerificationFailurePathsFromTasks,
  staleDownstreamVerificationSurfacePathsFromOrderedTasks,
  staleWorkspaceVerificationRemediation as staleWorkspaceVerificationRemediationFromTasks,
  typeScriptDiagnosticsFromRemediation as typeScriptDiagnosticsFromRemediationBase,
  typeScriptDiagnosticsFromText as typeScriptDiagnosticsFromTextBase,
  type TypeScriptDiagnostic,
} from '../implementation-retry-policy';
import { appendDeliveryEventState } from '../state-service';
import { topoOrderTasks } from '../task-plan-dependencies';
import type { Task, TaskPlan } from '../workflow-schemas';
import {
  compileSafeStubForSurface,
  taskBoundaryAllowsRepairPath,
  taskBoundarySurfaces,
} from './task-boundaries';
import { reusableImplementationArtifactForTask } from './reusable-artifacts';

export function staleDownstreamVerificationSurfacePaths({
  repoPath,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  return staleDownstreamVerificationSurfacePathsFromOrderedTasks({
    repoPath,
    orderedTasks: topoOrderTasks(taskPlan.tasks),
    currentTaskIndex,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
    reusableImplementationArtifactForTask: (task) => reusableImplementationArtifactForTask(repoPath, task),
  });
}

export function outOfPlanVerificationFailurePaths({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  return outOfPlanVerificationFailurePathsFromTasks({
    repoPath,
    tasks: taskPlan.tasks,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
  });
}

function deliveryImplementationNoteTouchedPaths(repoPath: string) {
  const artifactsDir = join(resolve(repoPath), '.delivery', 'artifacts');
  const touched = new Set<string>();

  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.startsWith('note-') || !entry.endsWith('.json')) continue;

      try {
        const note = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        const record = note && typeof note === 'object' ? (note as Record<string, unknown>) : undefined;
        if (record?.artifact_type !== 'implementation-note' || !Array.isArray(record.files_touched)) continue;
        for (const file of record.files_touched) {
          if (typeof file !== 'string') continue;
          const normalized = normalizeDeliveryPathReference(file);
          if (normalized) touched.add(normalized);
        }
      } catch {
        // Partial or unrelated JSON artifacts are not provenance evidence.
      }
    }
  };

  visit(artifactsDir);
  return touched;
}

export function staleOutOfPlanVerificationSurfacePaths({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  const deliveryTouchedPaths = deliveryImplementationNoteTouchedPaths(repoPath);
  if (!deliveryTouchedPaths.size) return [];

  return outOfPlanVerificationFailurePaths({ repoPath, taskPlan, failure }).filter((path) =>
    deliveryTouchedPaths.has(path),
  );
}

export function staleWorkspaceVerificationRemediation({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan?: TaskPlan;
  failure: string;
}) {
  return staleWorkspaceVerificationRemediationFromTasks({
    repoPath,
    tasks: taskPlan?.tasks,
    failure,
    taskBoundarySurfaces: (task) => taskBoundarySurfaces(repoPath, task),
    compactDiagnostic,
  });
}

export async function repairStaleDownstreamVerificationSurfaces({
  repoPath,
  mastra,
  stage,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const paths = staleDownstreamVerificationSurfacePaths({
    repoPath,
    taskPlan,
    currentTaskIndex,
    failure,
  });
  if (!paths.length) return false;

  for (const path of paths) {
    writeFileSync(join(resolve(repoPath), path), compileSafeStubForSurface(path));
  }

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths,
      output_summary:
        'Reset stale downstream task surfaces to compile-safe preflight stubs after repo-wide verification failed.',
    },
  }).catch(() => undefined);
  return true;
}

export async function repairStaleOutOfPlanVerificationSurfaces({
  repoPath,
  mastra,
  stage,
  taskPlan,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  const paths = staleOutOfPlanVerificationSurfacePaths({
    repoPath,
    taskPlan,
    failure,
  });
  if (!paths.length) return false;

  for (const path of paths) {
    writeFileSync(join(resolve(repoPath), path), compileSafeStubForSurface(path));
  }

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths,
      output_summary:
        'Reset stale out-of-plan delivery-generated surfaces to compile-safe preflight stubs after repo-wide verification failed.',
    },
  }).catch(() => undefined);
  return true;
}

function policyDeniedWriteEvents(events: DeliveryEvent[], stage: string) {
  return stageSlice(events, stage).filter(
    (event) =>
      event.type === 'tool_use' &&
      event.ok === false &&
      /\b(outside this task's owned surfaces|outside .* owned globs|forbidden glob)\b/i.test(String(event.error ?? '')),
  );
}

export function implementationEnginePolicyMismatch({
  repoPath,
  stage,
  role,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  task: Task;
  events: DeliveryEvent[];
}) {
  const taskSurfaces = taskBoundarySurfaces(repoPath, task);
  const mismatchedPaths = policyDeniedWriteEvents(events, stage)
    .flatMap((event) => event.paths ?? [])
    .filter((path) => {
      const clean = normalizeDeliveryPathReference(path);
      if (!clean || clean.startsWith('.delivery/')) return false;
      return fileOwnership({ role, paths: [clean] }).passed && matchesAny(clean, taskSurfaces);
    });

  const uniquePaths = Array.from(new Set(mismatchedPaths.map(normalizeDeliveryPathReference)));
  if (!uniquePaths.length) return [];

  return [
    `ENGINE_POLICY_MISMATCH ${task.id}: workspace policy rejected path(s) that normalize inside ${role}/${task.id} boundaries: ${uniquePaths.join(', ')}. This is a delivery engine boundary bug; do not spend model retries on it.`,
  ];
}

export type { TypeScriptDiagnostic };

export function typeScriptDiagnosticsFromText(text: string) {
  return typeScriptDiagnosticsFromTextBase(text);
}

export function typeScriptDiagnosticsFromRemediation(remediation: string[]) {
  return typeScriptDiagnosticsFromRemediationBase(remediation);
}

export function implementationFailureClass(remediation: string[]) {
  return implementationFailureClassBase(remediation);
}

export function canSalvageTimedOutBuildAttempt({
  stageHadToolUse,
  missingSurfaces,
  unreplacedStubs,
}: {
  stageHadToolUse: boolean;
  missingSurfaces: string[];
  unreplacedStubs: string[];
}) {
  return canSalvageTimedOutBuildAttemptBase({ stageHadToolUse, missingSurfaces, unreplacedStubs });
}

export function implementationRetryMode({
  remediation,
  missingSurfaces,
  unreplacedStubs = [],
}: {
  remediation: string[];
  missingSurfaces: string[];
  unreplacedStubs?: string[];
}) {
  return implementationRetryModeBase({ remediation, missingSurfaces, unreplacedStubs });
}

export function implementationToolChoiceForRetryMode(retryMode: ReturnType<typeof implementationRetryMode>) {
  return implementationToolChoiceForRetryModeBase(retryMode);
}

export function judgeRepairAlreadyAttempted(remediation: string[]) {
  return remediation.some((item) => /^JUDGE repair attempt:/i.test(item));
}

export function implementationJudgeRepairRemediation(judgmentPath: string, remediation: string[]) {
  return [`JUDGE repair attempt: fix failed implementation judgment ${judgmentPath}`, ...remediation];
}

export function implementationJudgeTimeoutRemediation(taskId: string, attemptNumber: number, timeoutMs: number) {
  return [
    `JUDGE_TIMEOUT ${taskId}.a${attemptNumber}: implementation judgment timed out after ${timeoutMs}ms. Preserve working code, improve direct evidence or the implementation note if needed, and retry with bounded judgment.`,
  ];
}

export function buildTimeoutRemediation({
  task,
  timeoutMs,
  missingSurfaces,
  repairRecovery,
  noToolCall = false,
  readBudgetExceeded = false,
  priorRemediation = [],
}: {
  task: Task;
  timeoutMs: number;
  missingSurfaces: string[];
  repairRecovery: boolean;
  noToolCall?: boolean;
  readBudgetExceeded?: boolean;
  priorRemediation?: string[];
}) {
  return buildTimeoutRemediationForTaskId({
    taskId: task.id,
    timeoutMs,
    missingSurfaces,
    repairRecovery,
    noToolCall,
    readBudgetExceeded,
    priorRemediation,
  });
}

function repairUnknownNumberIntegerLine(line: string) {
  return line.replace(/\bNumber\.isInteger\(([_$A-Za-z][_$A-Za-z0-9]*)\)\s*&&/g, (match, identifier, offset) => {
    const prefix = line.slice(0, offset);
    const narrowingPattern = new RegExp(`typeof\\s+${identifier}\\s*===\\s*["']number["']`);
    if (narrowingPattern.test(prefix)) return match;
    return `typeof ${identifier} === "number" && ${match}`;
  });
}

export async function repairUnknownNumberIntegerNarrowing({
  repoPath,
  mastra,
  stage,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const currentTask = topoOrderTasks(taskPlan.tasks)[currentTaskIndex];
  if (!currentTask) return false;

  const diagnostics = typeScriptDiagnosticsFromText(failure).filter(
    (diagnostic) => diagnostic.code === 'TS18046' && /\bunknown\b/i.test(diagnostic.message),
  );
  if (!diagnostics.length) return false;

  const repairedPaths: string[] = [];
  for (const path of new Set(diagnostics.map((diagnostic) => diagnostic.path))) {
    if (!taskBoundaryAllowsRepairPath(repoPath, currentTask, path)) continue;
    const fullPath = join(resolve(repoPath), path);
    if (!existsSync(fullPath)) continue;

    const source = readFileSync(fullPath, 'utf8');
    const next = source
      .split('\n')
      .map((line) => repairUnknownNumberIntegerLine(line))
      .join('\n');
    if (next === source) continue;

    writeFileSync(fullPath, next);
    repairedPaths.push(path);
  }

  if (!repairedPaths.length) return false;

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: repairedPaths,
      output_summary:
        'Added typeof number narrowing before Number.isInteger checks after TS18046 unknown-value typecheck failures.',
    },
  }).catch(() => undefined);
  return true;
}

export async function applyBuildVerificationRepair({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  failure,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  failure: string;
}) {
  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairStaleDownstreamVerificationSurfaces({
      repoPath,
      mastra,
      stage,
      taskPlan,
      currentTaskIndex: taskIndex,
      failure,
    }))
  ) {
    return true;
  }

  if (
    taskPlan &&
    (await repairStaleOutOfPlanVerificationSurfaces({
      repoPath,
      mastra,
      stage,
      taskPlan,
      failure,
    }))
  ) {
    return true;
  }

  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairUnknownNumberIntegerNarrowing({
      repoPath,
      mastra,
      stage,
      taskPlan,
      currentTaskIndex: taskIndex,
      failure,
    }))
  ) {
    return true;
  }

  if (!/Cannot find name 'WorkflowEvent'/.test(failure)) return false;

  const path = 'src/workflows/weekly.ts';
  const fullPath = join(resolve(repoPath), path);
  if (!existsSync(fullPath)) return false;

  const source = readFileSync(fullPath, 'utf8');
  const next = source.replace(
    "import { WorkflowEntrypoint } from 'cloudflare:workers';",
    "import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers';",
  );
  if (next === source) return false;

  writeFileSync(fullPath, next);
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: [path],
      output_summary: 'Imported WorkflowEvent from cloudflare:workers after typecheck failure.',
    },
  });
  return true;
}
