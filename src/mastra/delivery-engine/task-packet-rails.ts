import { normalizeDeliveryPathReference } from './checks';
import type { ScaffoldManifest, TestRuntimeKind } from './project-factory/schemas';
import type { Task, TaskMetadata, TaskPlan } from './workflow-schemas';

export type VerificationCommandClass =
  | 'node-unit'
  | 'worker-unit'
  | 'frontend-dom'
  | 'wrangler-local'
  | 'typecheck'
  | 'static';

export interface TaskPacketRailsInput {
  taskPlan: TaskPlan;
  task: Task;
  scaffoldManifest?: ScaffoldManifest;
  boundarySurfaces?: string[];
  generatedSurfaces?: string[];
  directDependencySurfaces?: string[];
  sourceContracts?: string[];
  maxAttempts: number;
  maxToolStepsPerAttempt?: number;
}

export interface TaskPacketRails {
  allowed_surfaces: string[];
  scaffold_owned_allowed_surfaces: string[];
  scaffold_owned_readonly_surfaces: string[];
  generated_outputs: string[];
  direct_dependency_surfaces: string[];
  runtime_class: TestRuntimeKind | 'none';
  evidence_kind: NonNullable<TaskMetadata['evidence']>['kind'] | 'none';
  surface_kind: NonNullable<TaskMetadata['surface']>['kind'] | 'unknown';
  task_kind: NonNullable<TaskMetadata['task']>['kind'] | 'product';
  source_contracts: string[];
  verification_command_class: VerificationCommandClass;
  edit_policy: {
    may_edit_scaffold_owned_files: boolean;
    scaffold_owned_files_are_readonly_unless_allowed: true;
    reason: string;
  };
  model_budget: {
    stage: 'build';
    max_attempts: number;
    max_model_calls: number;
    max_tool_steps_per_attempt?: number;
  };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function normalizedSurface(surface: string | undefined) {
  if (!surface) return undefined;
  const normalized = normalizeDeliveryPathReference(surface);
  if (!normalized || normalized.includes('*') || /^unknown\b/i.test(normalized)) return undefined;
  return normalized;
}

function normalizedSurfaces(surfaces: readonly string[] | undefined) {
  return unique((surfaces ?? []).map(normalizedSurface).filter((surface): surface is string => Boolean(surface)));
}

function dependencySurfacePaths(taskPlan: TaskPlan, task: Task, allowedSurfaces: readonly string[]) {
  const byId = new Map(taskPlan.tasks.map((candidate) => [candidate.id, candidate]));
  const allowed = new Set(allowedSurfaces);
  const paths = task.depends_on.flatMap((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency ? normalizedSurfaces(dependency.owned_surfaces) : [];
  });
  return unique(paths.filter((path) => !allowed.has(path)));
}

export function verificationCommandClassForTask(task: Task): VerificationCommandClass {
  const runtime = task.metadata?.runtime?.kind;
  if (runtime === 'node') return 'node-unit';
  if (runtime === 'worker') return 'worker-unit';
  if (runtime === 'jsdom') return 'frontend-dom';
  if (runtime === 'wrangler') return 'wrangler-local';

  const evidenceKind = task.metadata?.evidence?.kind;
  if (evidenceKind === 'local-gate') return 'wrangler-local';
  if (evidenceKind && evidenceKind !== 'none') return 'node-unit';

  const taskKind = task.metadata?.task?.kind;
  if (taskKind === 'operator-docs') return 'static';
  if (taskKind === 'contract') return 'node-unit';
  if (['worker', 'storage', 'provider-adapter', 'workflow', 'scaffold'].includes(taskKind ?? '')) {
    return 'typecheck';
  }

  const surfaceKind = task.metadata?.surface?.kind;
  if (surfaceKind === 'frontend' || surfaceKind === 'metadata') return 'static';
  if (surfaceKind === 'contract' || surfaceKind === 'test') return 'node-unit';
  if (surfaceKind === 'worker' || surfaceKind === 'migration' || surfaceKind === 'config') return 'typecheck';

  return 'typecheck';
}

export function taskPacketRailsForTask({
  taskPlan,
  task,
  scaffoldManifest,
  boundarySurfaces,
  generatedSurfaces,
  directDependencySurfaces,
  sourceContracts,
  maxAttempts,
  maxToolStepsPerAttempt,
}: TaskPacketRailsInput): TaskPacketRails {
  const allowedSurfaces = normalizedSurfaces(boundarySurfaces?.length ? boundarySurfaces : task.owned_surfaces);
  const scaffoldOwned = new Set(normalizedSurfaces(scaffoldManifest?.generatedFiles));
  const scaffoldOwnedAllowed = allowedSurfaces.filter((path) => scaffoldOwned.has(path));
  const scaffoldOwnedReadonly = normalizedSurfaces(scaffoldManifest?.generatedFiles).filter(
    (path) => !allowedSurfaces.includes(path),
  );
  const dependencySurfaces = normalizedSurfaces(
    directDependencySurfaces?.length
      ? directDependencySurfaces
      : dependencySurfacePaths(taskPlan, task, allowedSurfaces),
  );
  const normalizedGeneratedOutputs = normalizedSurfaces(generatedSurfaces);
  const mayEditScaffoldOwned = scaffoldOwnedAllowed.length > 0;

  return {
    allowed_surfaces: allowedSurfaces,
    scaffold_owned_allowed_surfaces: scaffoldOwnedAllowed,
    scaffold_owned_readonly_surfaces: scaffoldOwnedReadonly,
    generated_outputs: normalizedGeneratedOutputs,
    direct_dependency_surfaces: dependencySurfaces,
    runtime_class: task.metadata?.runtime?.kind ?? 'none',
    evidence_kind: task.metadata?.evidence?.kind ?? 'none',
    surface_kind: task.metadata?.surface?.kind ?? 'unknown',
    task_kind: task.metadata?.task?.kind ?? 'product',
    source_contracts: unique((sourceContracts ?? task.source_acceptance_criteria ?? []).filter(Boolean)),
    verification_command_class: verificationCommandClassForTask(task),
    edit_policy: {
      may_edit_scaffold_owned_files: mayEditScaffoldOwned,
      scaffold_owned_files_are_readonly_unless_allowed: true,
      reason: mayEditScaffoldOwned
        ? 'This task explicitly owns one or more scaffold-generated surfaces; only those listed scaffold surfaces may be edited.'
        : 'Scaffold-generated files are read-only for this task; change product-owned source surfaces instead.',
    },
    model_budget: {
      stage: 'build',
      max_attempts: maxAttempts,
      max_model_calls: maxAttempts,
      ...(maxToolStepsPerAttempt ? { max_tool_steps_per_attempt: maxToolStepsPerAttempt } : {}),
    },
  };
}
