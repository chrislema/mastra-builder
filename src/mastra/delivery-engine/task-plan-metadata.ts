import { normalizeDeliveryPathReference } from './checks';
import { classifyTestRuntime } from './project-factory/test-runtime-matrix';
import type { ScaffoldManifest, ScaffoldSurfaceKind, TestRuntimeKind } from './project-factory/schemas';
import type { Task, TaskMetadata, TaskPlan } from './workflow-schemas';

type EvidenceKind = NonNullable<TaskMetadata['evidence']>['kind'];
type TaskKind = NonNullable<TaskMetadata['task']>['kind'];

const surfacePriority: ScaffoldSurfaceKind[] = ['test', 'migration', 'contract', 'worker', 'frontend', 'config', 'metadata'];

function normalizedTaskSurfaces(task: Task) {
  return task.owned_surfaces.map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

function inferredSurfaceKind(path: string): ScaffoldSurfaceKind | undefined {
  if (/^test\/.+\.test\.[cm]?[jt]s$/i.test(path)) return 'test';
  if (/^migrations\/.+\.sql$/i.test(path)) return 'migration';
  if (/^public\/.+/i.test(path)) return 'frontend';
  if (/^src\/(?:contracts|validation|domain)(?:\/.+)?\.[cm]?[jt]s$/i.test(path)) return 'contract';
  if (/^(?:src|workers)\/.+\.[cm]?[jt]s$/i.test(path) || /^worker\.[cm]?[jt]s$/i.test(path)) return 'worker';
  if (/^(?:package\.json|wrangler\.(?:jsonc?|toml)|tsconfig\.json|vitest\.config\.[cm]?[jt]s)$/i.test(path)) {
    return 'config';
  }
  if (/^(?:README\.md|\.gitignore|\.dev\.vars\.example)$/i.test(path)) return 'metadata';
  return undefined;
}

function surfaceKindForTask(task: Task, manifest?: ScaffoldManifest): ScaffoldSurfaceKind | undefined {
  const surfaceKinds = normalizedTaskSurfaces(task).flatMap((path) => {
    const manifestKind = manifest?.generatedFileSurfaces[path];
    const inferred = manifestKind ?? inferredSurfaceKind(path);
    return inferred ? [inferred] : [];
  });

  return surfacePriority.find((kind) => surfaceKinds.includes(kind));
}

function evidenceKindForSurface(path: string): EvidenceKind {
  if (!/^test\/.+\.test\.[cm]?[jt]s$/i.test(path)) return 'none';
  if (/provider-adapters\.test\.[cm]?[jt]s$/i.test(path)) return 'provider-adapter';
  if (/api-routes\.test\.[cm]?[jt]s$/i.test(path)) return 'api-route';
  if (/worker-smoke\.test\.[cm]?[jt]s$/i.test(path) || /\.worker\.test\.[cm]?[jt]s$/i.test(path)) return 'worker-smoke';
  if (/(?:frontend|ui)-.+\.test\.[cm]?[jt]s$/i.test(path)) return 'frontend';
  if (/validation\.test\.[cm]?[jt]s$/i.test(path)) return 'validation';
  if (/(?:contracts|domain)\.test\.[cm]?[jt]s$/i.test(path) || /\.node\.test\.[cm]?[jt]s$/i.test(path)) return 'contract';
  return 'contract';
}

function evidenceKindForTask(task: Task): EvidenceKind {
  const testSurface = normalizedTaskSurfaces(task).find((path) => /^test\/.+\.test\.[cm]?[jt]s$/i.test(path));
  return testSurface ? evidenceKindForSurface(testSurface) : 'none';
}

function runtimeKindForTask(task: Task): TestRuntimeKind | undefined {
  const testSurface = normalizedTaskSurfaces(task).find((path) => /^test\/.+\.test\.[cm]?[jt]s$/i.test(path));
  return testSurface ? classifyTestRuntime(testSurface) : undefined;
}

function taskKindForTask(task: Task, surfaceKind?: ScaffoldSurfaceKind, evidenceKind?: EvidenceKind): TaskKind {
  if (evidenceKind && evidenceKind !== 'none') return 'evidence';
  if (surfaceKind === 'test') return 'evidence';
  if (surfaceKind === 'migration') return 'storage';
  if (surfaceKind === 'contract') return 'contract';
  if (surfaceKind === 'frontend') return 'frontend';
  if (surfaceKind === 'worker') {
    const text = [task.deliverable, ...task.owned_surfaces].join('\n');
    if (/\bprovider|adapter|AI\b/i.test(text)) return 'provider-adapter';
    if (/\bworkflow|WorkflowEntrypoint\b/i.test(text)) return 'workflow';
    return 'worker';
  }
  if (normalizedTaskSurfaces(task).includes('README.md')) return 'operator-docs';
  if (normalizedTaskSurfaces(task).some((path) => /^(?:package\.json|wrangler\.(?:jsonc?|toml)|tsconfig\.json)$/i.test(path))) {
    return 'scaffold';
  }
  return 'product';
}

function factoryOwnedScaffoldMetadata(task: Task, manifest?: ScaffoldManifest): TaskMetadata['scaffold'] {
  if (!manifest) return undefined;
  const generated = new Set(manifest.generatedFiles.map((path) => normalizeDeliveryPathReference(path)).filter(Boolean));
  const generatedFiles = normalizedTaskSurfaces(task).filter((path) => generated.has(path));
  if (!generatedFiles.length) return undefined;

  const concreteSurfaces = normalizedTaskSurfaces(task).filter((path) => !/^unknown:/i.test(path));
  return {
    owned_by_factory: concreteSurfaces.length > 0 && concreteSurfaces.every((path) => generated.has(path)),
    generated_files: generatedFiles,
  };
}

function metadataForTask(task: Task, manifest?: ScaffoldManifest): TaskMetadata {
  const surfaceKind = surfaceKindForTask(task, manifest);
  const evidenceKind = evidenceKindForTask(task);
  const runtimeKind = runtimeKindForTask(task);
  const taskKind = taskKindForTask(task, surfaceKind, evidenceKind);
  const scaffold = factoryOwnedScaffoldMetadata(task, manifest);

  return {
    ...(task.metadata ?? {}),
    task: { kind: taskKind },
    ...(surfaceKind ? { surface: { kind: surfaceKind } } : {}),
    evidence: { kind: evidenceKind },
    ...(runtimeKind ? { runtime: { kind: runtimeKind } } : {}),
    ...(scaffold ? { scaffold } : {}),
  };
}

export function annotateTaskPlanWithTypedMetadata(taskPlan: TaskPlan, manifest?: ScaffoldManifest): TaskPlan {
  return {
    ...taskPlan,
    tasks: taskPlan.tasks.map((task) => ({
      ...task,
      metadata: metadataForTask(task, manifest),
    })),
  };
}
