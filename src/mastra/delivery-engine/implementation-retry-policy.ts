import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { matchesAny, normalizeDeliveryPathReference } from './checks';
import type { Task } from './workflow-schemas';

export function verificationFailurePaths(failure: string) {
  const paths = new Set<string>();
  const pathPattern =
    /(?:^|\n)([^\s:()]+(?:\/[^\s:()]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|html?))(?::\d+(?::\d+)?|\(\d+,\d+\))/g;
  for (const match of failure.matchAll(pathPattern)) {
    const path = normalizeDeliveryPathReference(match[1]);
    if (!path.startsWith('.delivery/') && !path.startsWith('node_modules/')) paths.add(path);
  }
  return [...paths];
}

export type TaskSurfaceResolver = (task: Task) => string[];
export type TaskReusePredicate = (task: Task) => unknown;

export function staleDownstreamVerificationSurfacePathsFromOrderedTasks({
  repoPath,
  orderedTasks,
  currentTaskIndex,
  failure,
  taskBoundarySurfaces,
  reusableImplementationArtifactForTask,
}: {
  repoPath: string;
  orderedTasks: Task[];
  currentTaskIndex: number;
  failure: string;
  taskBoundarySurfaces: TaskSurfaceResolver;
  reusableImplementationArtifactForTask: TaskReusePredicate;
}) {
  const protectedSurfaces = orderedTasks
    .slice(0, currentTaskIndex + 1)
    .flatMap(taskBoundarySurfaces)
    .map(concretePath)
    .filter((path): path is string => Boolean(path));
  const downstreamTasks = orderedTasks.slice(currentTaskIndex + 1);

  return verificationFailurePaths(failure).filter((path) => {
    if (!existsSync(join(resolve(repoPath), path))) return false;
    if (matchesAny(path, protectedSurfaces)) return false;

    return downstreamTasks.some((task) => {
      if (reusableImplementationArtifactForTask(task)) return false;
      return matchesAny(path, taskBoundarySurfaces(task));
    });
  });
}

export function outOfPlanVerificationFailurePathsFromTasks({
  repoPath,
  tasks,
  failure,
  taskBoundarySurfaces,
}: {
  repoPath: string;
  tasks: Task[];
  failure: string;
  taskBoundarySurfaces: TaskSurfaceResolver;
}) {
  const allPlannedSurfaces = tasks
    .flatMap(taskBoundarySurfaces)
    .map(concretePath)
    .filter((path): path is string => Boolean(path));

  return verificationFailurePaths(failure).filter((path) => {
    if (!existsSync(join(resolve(repoPath), path))) return false;
    return !matchesAny(path, allPlannedSurfaces);
  });
}

function concretePath(surface: string) {
  const path = normalizeDeliveryPathReference(surface);
  if (!path || path.includes('*') || /^unknown\b/i.test(path)) return undefined;
  return path;
}

export function staleWorkspaceVerificationRemediation({
  repoPath,
  tasks,
  failure,
  taskBoundarySurfaces,
  compactDiagnostic,
}: {
  repoPath: string;
  tasks?: Task[];
  failure: string;
  taskBoundarySurfaces: TaskSurfaceResolver;
  compactDiagnostic: (error: unknown, limit?: number) => string;
}) {
  if (!tasks) return undefined;
  const paths = outOfPlanVerificationFailurePathsFromTasks({ repoPath, tasks, failure, taskBoundarySurfaces });
  if (!paths.length) return undefined;

  return `STALE_WORKSPACE_VERIFICATION: repo-wide verification failed in existing file(s) outside the current task plan: ${paths.join(', ')}. Start from a clean project baseline, archive stale generated files, or revise the plan so those files are owned before retrying. Original failure: ${compactDiagnostic(failure, 500)}`;
}

export function remediationHasVerificationFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(verification_passed|build_verification_passed|npm run|typecheck|tsc|TS\d+|Cannot find module)\b/i.test(item),
  );
}

function compactText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
}

export type TypeScriptDiagnostic = {
  path: string;
  line: number;
  column: number;
  code: string;
  message: string;
};

export function typeScriptDiagnosticsFromText(text: string) {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const seen = new Set<string>();
  const diagnosticPattern = /(^|\n)([^:\n()]+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+([^\n\r]+)/g;

  for (const match of text.matchAll(diagnosticPattern)) {
    const path = normalizeDeliveryPathReference(match[2] ?? '');
    const line = Number(match[3]);
    const column = Number(match[4]);
    const code = match[5] ?? '';
    const message = (match[6] ?? '').trim();
    if (!path || !Number.isInteger(line) || !Number.isInteger(column) || !code || !message) continue;

    const key = `${path}:${line}:${column}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ path, line, column, code, message });
  }

  return diagnostics;
}

export function verificationFailureSummaryFromCommandError(error: unknown, limit = 1000) {
  let text: string;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const parts = [
      typeof record.message === 'string' ? record.message : undefined,
      typeof record.stdout === 'string' && record.stdout.trim() ? `stdout:\n${record.stdout}` : undefined,
      typeof record.stderr === 'string' && record.stderr.trim() ? `stderr:\n${record.stderr}` : undefined,
    ].filter(Boolean);
    text = parts.length ? parts.join('\n') : String(error);
  } else {
    text = String(error);
  }

  const diagnostics = typeScriptDiagnosticsFromText(text);
  if (!diagnostics.length) return compactText(text, limit);

  const diagnosticLines = diagnostics
    .slice(0, 12)
    .map((diagnostic) => `${diagnostic.path}(${diagnostic.line},${diagnostic.column}): error ${diagnostic.code}: ${diagnostic.message}`);
  if (diagnostics.length > diagnosticLines.length) {
    diagnosticLines.push(`... ${diagnostics.length - diagnosticLines.length} more TypeScript diagnostic(s)`);
  }

  return [
    'TypeScript diagnostics:',
    ...diagnosticLines,
    '',
    `Command failure summary: ${compactText(text, Math.max(200, limit - diagnosticLines.join('\n').length))}`,
  ].join('\n');
}

export function typeScriptDiagnosticsFromRemediation(remediation: string[]) {
  return typeScriptDiagnosticsFromText(remediation.join('\n'));
}

function remediationHasStaleWorkspaceVerificationFailure(remediation: string[]) {
  return remediation.some((item) => /\bSTALE_WORKSPACE_VERIFICATION\b/i.test(item));
}

function remediationHasScaffoldBaselineVerificationFailure(remediation: string[]) {
  return remediation.some((item) => /\bSCAFFOLD_BASELINE_VERIFICATION\b/i.test(item));
}

function remediationHasImplementationJudgmentFailure(remediation: string[]) {
  return remediation.some((item) => /\b(GATE|DIMENSION|JUDGE|implementation judgment)\b/i.test(item));
}

function remediationHasJudgeTimeout(remediation: string[]) {
  return remediation.some((item) => /\bJUDGE_TIMEOUT\b|judge.+timed out/i.test(item));
}

function remediationHasMissingSurfaceFailure(remediation: string[]) {
  return remediation.some((item) => /\bowned_surfaces_present\b.*\bmissing owned surfaces\b/i.test(item));
}

function remediationHasUnreplacedPreflightStubFailure(remediation: string[]) {
  return remediation.some((item) => /\b(preflight_stubs_replaced|preflight stubs remain)\b/i.test(item));
}

function remediationHasPolicyBoundaryFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(file_ownership|write_paths_in_boundary|owned globs|forbidden glob|outside this task)\b/i.test(
      item,
    ),
  );
}

function remediationHasReadBudgetFailure(remediation: string[]) {
  return remediation.some((item) => /\bREAD_BUDGET_EXCEEDED\b|pre-write read\/list budget/i.test(item));
}

function remediationHasWorkerConfigFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(cloudflare_worker_config_current|worker_config_hygiene|compatibility_date|nodejs_compat|observability)\b/i.test(
      item,
    ),
  );
}

function remediationHasWorkerPackageFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(worker_package_scaffold_current|worker_package_hygiene|worker-configuration\.d\.ts|generate-types|generated Wrangler types|wrangler v4|new Worker scaffolds)\b/i.test(
      item,
    ),
  );
}

export function implementationFailureClass(remediation: string[]) {
  if (remediationHasMissingSurfaceFailure(remediation)) return 'missing_surface' as const;
  if (remediationHasUnreplacedPreflightStubFailure(remediation)) return 'preflight_stub' as const;
  if (remediationHasReadBudgetFailure(remediation)) return 'read_budget' as const;
  if (remediationHasWorkerPackageFailure(remediation)) return 'worker_package' as const;
  if (remediationHasWorkerConfigFailure(remediation)) return 'worker_config' as const;
  if (remediationHasScaffoldBaselineVerificationFailure(remediation)) return 'scaffold_baseline_verification' as const;
  if (remediationHasStaleWorkspaceVerificationFailure(remediation)) return 'stale_workspace_verification' as const;
  if (remediationHasVerificationFailure(remediation)) return 'code_verification' as const;
  if (remediationHasPolicyBoundaryFailure(remediation)) return 'policy_boundary' as const;
  if (remediationHasJudgeTimeout(remediation)) return 'judge_timeout' as const;
  if (remediationHasImplementationJudgmentFailure(remediation)) return 'judge_quality' as const;
  if (remediation.some((item) => /\b(no tool calls|without making a tool call|made no tool calls)\b/i.test(item))) {
    return 'model_no_action' as const;
  }
  if (remediation.some((item) => /timed out/i.test(item))) return 'model_timeout' as const;
  return 'unknown' as const;
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
  return stageHadToolUse && missingSurfaces.length === 0 && unreplacedStubs.length === 0;
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
  const timeoutRecovery = remediation.some((item) => /timed out/i.test(item));
  const failureClass = implementationFailureClass(remediation);
  const noActionRecovery = failureClass === 'model_no_action';
  if (failureClass === 'preflight_stub' || (unreplacedStubs.length && (timeoutRecovery || noActionRecovery))) {
    return 'replace-stubs' as const;
  }
  if (
    (timeoutRecovery || noActionRecovery || failureClass === 'missing_surface' || failureClass === 'read_budget') &&
    missingSurfaces.length
  ) {
    return 'write-first' as const;
  }
  if (
    timeoutRecovery ||
    noActionRecovery ||
    failureClass === 'read_budget' ||
    failureClass === 'worker_package' ||
    failureClass === 'worker_config' ||
    failureClass === 'policy_boundary' ||
    failureClass === 'judge_timeout' ||
    remediationHasVerificationFailure(remediation) ||
    remediationHasImplementationJudgmentFailure(remediation)
  ) {
    return 'focused-repair' as const;
  }
  return 'normal' as const;
}

export function implementationToolChoiceForRetryMode(retryMode: ReturnType<typeof implementationRetryMode>) {
  return retryMode === 'write-first' || retryMode === 'replace-stubs' || retryMode === 'focused-repair'
    ? 'required'
    : 'auto';
}

function preservePriorRemediation(primary: string[], priorRemediation: string[]) {
  return [...primary, ...priorRemediation.filter((item) => !primary.includes(item))];
}

export function buildTimeoutRemediation({
  taskId,
  timeoutMs,
  missingSurfaces,
  repairRecovery,
  noToolCall = false,
  readBudgetExceeded = false,
  priorRemediation = [],
}: {
  taskId: string;
  timeoutMs: number;
  missingSurfaces: string[];
  repairRecovery: boolean;
  noToolCall?: boolean;
  readBudgetExceeded?: boolean;
  priorRemediation?: string[];
}) {
  if (readBudgetExceeded && missingSurfaces.length) {
    return [
      `READ_BUDGET_EXCEEDED ${taskId}: the build attempt exhausted the pre-write read/list budget before creating owned surfaces. Create the missing owned surfaces now without listing or reading more files: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (readBudgetExceeded) {
    return preservePriorRemediation(
      [
        `READ_BUDGET_EXCEEDED ${taskId}: the build attempt exhausted the pre-write read/list budget. Make a focused write/edit to the boundary surfaces before any more reads.`,
      ],
      priorRemediation,
    );
  }

  if (noToolCall && missingSurfaces.length) {
    return [
      `${taskId} build attempt made no tool calls after ${timeoutMs}ms. Create the missing owned surfaces before any broad investigation: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (noToolCall && repairRecovery) {
    return preservePriorRemediation([
      `${taskId} repair attempt made no tool calls after ${timeoutMs}ms. Make a focused write to the existing boundary surfaces before returning.`,
    ], priorRemediation);
  }

  if (noToolCall) {
    return [
      `${taskId} build attempt made no tool calls after ${timeoutMs}ms. Make a focused write to the boundary surfaces before returning.`,
    ];
  }

  if (missingSurfaces.length) {
    return [
      `${taskId} build attempt timed out after ${timeoutMs}ms. Create the missing owned surfaces before any broad investigation: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (repairRecovery) {
    return preservePriorRemediation([
      `${taskId} repair attempt timed out after ${timeoutMs}ms. Fix the reported repair findings in the existing boundary surfaces before any broad investigation.`,
    ], priorRemediation);
  }

  return [
    `${taskId} build attempt timed out after ${timeoutMs}ms. Edit the boundary surfaces before any broad investigation.`,
  ];
}
