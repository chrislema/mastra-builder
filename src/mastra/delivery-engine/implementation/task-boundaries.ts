import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownsTypeScriptInputSurface, workerSourceSurfaceIsConcrete } from '../planning/scaffold-policy';
import {
  concreteOwnedSurfacePath,
  effectiveOwnedSurfaces,
  taskOwnsExactSurface as ownsExactSurface,
  taskOwnsWorkerConfigFile,
} from '../task-plan-surface-policy';
import {
  missingInstalledPackageNames as workerMissingInstalledPackageNames,
  repoUsesTypeScriptWorkerSource as workerRepoUsesTypeScriptWorkerSource,
  workerConfigHygieneGaps as workerConfigHygieneGapsWithGuards,
  workerConfigTaskPacketPolicy as workerConfigTaskPacketPolicyBase,
  workerEnvBindingAlignmentGaps as workerEnvBindingAlignmentGapsBase,
  workerPackageScaffoldGaps as workerPackageScaffoldGapsWithGuards,
  workersAiBindingGaps as workersAiBindingGapsWithGuards,
  wranglerConfigHasWorkersAiBinding as wranglerConfigHasWorkersAiBindingBase,
  type WorkerHygieneTaskGuards,
} from '../worker-hygiene';
import type { Task } from '../workflow-schemas';

const moduleSourceExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;

function firstExistingRepoPath(repoPath: string, candidates: string[]) {
  return candidates.find((candidate) => existsSync(join(resolve(repoPath), candidate)));
}

export function taskBoundarySurfaces(repoPath: string, task: Task) {
  const surfaces = new Set(effectiveOwnedSurfaces(task));
  for (const surface of effectiveOwnedSurfaces(task)) {
    const path = concreteOwnedSurfacePath(surface);
    if (!path || !path.includes('/')) continue;
    const parts = path.split('/');
    parts.pop();
    const directory = parts.join('/');
    if (!directory) continue;
    const barrel = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `${directory}/index.${extension}`),
    );
    if (barrel) surfaces.add(barrel);

    const workerEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/index.${extension}`),
    );
    if (directory === 'src/routes' && workerEntry) {
      surfaces.add(workerEntry);
    }

    const workflowEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/workflows/weekly.${extension}`),
    );
    if (directory === 'src/workflows/steps' && workflowEntry) {
      surfaces.add(workflowEntry);
    }
  }

  return [...surfaces];
}

export function workerConfigTaskPacketPolicy() {
  return workerConfigTaskPacketPolicyBase();
}

export function currentWorkerCompatibilityDate() {
  return workerConfigTaskPacketPolicy().compatibility_date;
}

export function workerConfigTaskPacketPolicyForTask(task: Task) {
  return taskOwnsWorkerConfigFile(task) ? workerConfigTaskPacketPolicy() : null;
}

export function generatedTaskSurfacePaths(task: Task) {
  const policy = workerConfigTaskPacketPolicyForTask(task);
  const output = policy?.generated_types.output;
  return output ? [output] : [];
}

export function taskSourceBoundarySurfaces(repoPath: string, task: Task) {
  const generated = new Set(generatedTaskSurfacePaths(task));
  return taskBoundarySurfaces(repoPath, task).filter((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return !path || !generated.has(path);
  });
}

function taskBoundaryCanConfigureWorkersAi(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some(
      (path) =>
        ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path) || workerSourceSurfaceIsConcrete(path),
    );
}

function taskBoundaryCanConfigureWorkerConfig(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some((path) => ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path));
}

export function taskOwnsPackageManifest(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return path === 'package.json' || path === 'package-lock.json';
  });
}

function repoUsesTypeScriptWorkerSource(repoPath: string, task?: Task) {
  return (
    (task !== undefined && (ownsTypeScriptInputSurface(task) || ownsExactSurface(task, 'tsconfig.json'))) ||
    workerRepoUsesTypeScriptWorkerSource(repoPath)
  );
}

function workerHygieneTaskGuards(): WorkerHygieneTaskGuards {
  return {
    taskCanConfigureWorkerConfig: taskBoundaryCanConfigureWorkerConfig,
    taskCanConfigureWorkersAi: taskBoundaryCanConfigureWorkersAi,
    taskOwnsPackageManifest,
    repoUsesTypeScriptWorkerSource,
  };
}

export function workerEnvBindingAlignmentGaps(repoPath: string) {
  return workerEnvBindingAlignmentGapsBase(repoPath);
}

export function workerConfigHygieneGaps(repoPath: string, task?: Task) {
  return workerConfigHygieneGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}

export function wranglerConfigHasWorkersAiBinding(repoPath: string) {
  return wranglerConfigHasWorkersAiBindingBase(repoPath);
}

export function workersAiBindingGaps(repoPath: string, task?: Task) {
  return workersAiBindingGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}

export function missingInstalledPackageNames(repoPath: string) {
  return workerMissingInstalledPackageNames(repoPath);
}

export function workerPackageScaffoldGaps(repoPath: string, task?: Task) {
  return workerPackageScaffoldGapsWithGuards(repoPath, task, workerHygieneTaskGuards());
}
