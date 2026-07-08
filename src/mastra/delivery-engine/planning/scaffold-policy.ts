import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDeliveryPathReference } from '../checks';
import { canonicalRootWorkerScaffoldAcceptanceCriteria } from '../acceptance-contracts';
import {
  isWorkerConfigSurfacePath,
  normalizedOwnedSurfaces,
  taskOwnsAnyExactSurface,
  taskOwnsExactSurface,
  taskOwnsIndexSurface,
} from '../task-plan-surface-policy';
import { workerConfigPath, workerConfigSurfacePaths } from '../worker-hygiene';
import type { ScaffoldManifest } from '../project-factory/schemas';
import type { Task, TaskPlan } from '../workflow-schemas';

export function ownsPackageScaffold(task: Task) {
  return taskOwnsExactSurface(task, 'package.json');
}

export function taskIsRootScaffold(task: Task) {
  return task.depends_on.length === 0 && ownsPackageScaffold(task) && taskOwnsIndexSurface(task);
}

function ownsWorkerConfigSurface(task: Task) {
  return taskOwnsAnyExactSurface(task, workerConfigSurfacePaths);
}

function normalizeScaffoldRootTask(repoPath: string, task: Task, includeWorkerConfig: boolean) {
  const ownedSurfaces = [...task.owned_surfaces];
  const acceptanceCriteria = [...task.acceptance_criteria];
  const typeScriptScaffold = ownsTypeScriptInputSurface(task);

  if (!taskOwnsExactSurface(task, '.gitignore')) {
    ownedSurfaces.push('.gitignore');
  }

  if (includeWorkerConfig && !workerConfigPath(repoPath) && !ownsWorkerConfigSurface(task)) {
    ownedSurfaces.push('wrangler.jsonc');
  }

  if (typeScriptScaffold && !taskOwnsExactSurface(task, 'tsconfig.json')) {
    ownedSurfaces.push('tsconfig.json');
  }

  if (ownsJavaScriptInputSurface(task) && !typeScriptScaffold) {
    if (!taskOwnsExactSurface(task, 'scripts/check-js.js')) {
      ownedSurfaces.push('scripts/check-js.js');
    }
  }

  const normalizedSurfaces = Array.from(new Set(ownedSurfaces.map(normalizeDeliveryPathReference).filter(Boolean)));
  const entrypointSurface = normalizedSurfaces.find((surface) => /^src\/index\.(?:js|ts)$/.test(surface));
  acceptanceCriteria.push(
    ...canonicalRootWorkerScaffoldAcceptanceCriteria({
      entrypointSurface,
      ownsGitignore: normalizedSurfaces.includes('.gitignore'),
      ownsPackage: normalizedSurfaces.includes('package.json'),
      ownsWorkerConfig: normalizedSurfaces.some(isWorkerConfigSurfacePath),
      typeScript: typeScriptScaffold,
    }),
  );

  return {
    ...task,
    owned_surfaces: Array.from(new Set(ownedSurfaces)),
    acceptance_criteria: Array.from(new Set(acceptanceCriteria)),
  };
}

export function workerSourceSurfaceIsTypeScript(surface: string) {
  const normalized = surface.toLowerCase();
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized)) return false;
  return /\.(?:ts|tsx|mts|cts)$/.test(normalized);
}

function workerSourceSurfaceIsJavaScript(surface: string) {
  return /\.(?:js|mjs|cjs)$/.test(surface.toLowerCase());
}

function workerSourceSurfaceIsJavaScriptOrTypeScript(surface: string) {
  return /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/.test(surface);
}

export function workerSourceSurfaceIsConcrete(surface: string) {
  if (surface === 'src/**' || surface === 'workers/**') return true;
  if (surface === 'worker.js' || surface === 'worker.mjs' || surface === 'worker.ts') return true;
  return (
    (surface.startsWith('src/') || surface.startsWith('workers/')) &&
    workerSourceSurfaceIsJavaScriptOrTypeScript(surface)
  );
}

function ownsWorkerSourceInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(workerSourceSurfaceIsConcrete);
}

function ownsJavaScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      ((surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsJavaScript(surface)),
  );
}

export function ownsTypeScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      ((surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsTypeScript(surface)),
  );
}

function ownsWorkerRuntimeSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'wrangler.toml' ||
      surface === 'wrangler.json' ||
      surface === 'wrangler.jsonc' ||
      surface === 'src/**' ||
      surface === 'workers/**' ||
      surface === 'worker.js' ||
      surface === 'worker.mjs' ||
      surface === 'worker.ts' ||
      surface.startsWith('src/') ||
      surface.startsWith('workers/') ||
      surface.startsWith('public/') ||
      surface.startsWith('migrations/'),
  );
}

export function normalizeTaskPlanScaffoldDependencies(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  if (existsSync(join(repoPath, 'package.json'))) return taskPlan;
  if (!taskPlan.tasks.some(ownsWorkerRuntimeSurface)) return taskPlan;

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find((task) => ownsPackageScaffold(task) && ownsWorkerSourceInputSurface(task));
  if (!scaffoldRootTask) return taskPlan;

  let changed = false;
  const planAlreadyOwnsWorkerConfig = taskPlan.tasks.some(ownsWorkerConfigSurface);
  const tasks = taskPlan.tasks.map((task) => {
    if (task.id === scaffoldRootTask.id) {
      const normalizedTask = normalizeScaffoldRootTask(repoPath, task, !planAlreadyOwnsWorkerConfig);
      if (normalizedTask !== task) changed = true;
      return normalizedTask;
    }
    if (task.depends_on.length > 0 || !ownsWorkerRuntimeSurface(task) || ownsPackageScaffold(task)) {
      return task;
    }

    changed = true;
    return {
      ...task,
      depends_on: [scaffoldRootTask.id],
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

export function projectScaffoldHygiene(repoPath: string, taskPlan: TaskPlan, scaffoldManifest?: ScaffoldManifest) {
  if (existsSync(join(repoPath, 'package.json'))) return { passed: true, reason: 'ok' };
  if (
    scaffoldManifest?.generatedFiles.includes('package.json') &&
    scaffoldManifest.generatedFiles.includes(scaffoldManifest.main) &&
    scaffoldManifest.generatedFiles.some((path) => path === 'wrangler.jsonc' || path === 'wrangler.toml')
  ) {
    return {
      passed: true,
      reason: 'ok: deterministic project factory owns the root Worker scaffold before implementation.',
    };
  }

  const plansRuntimeWork = taskPlan.tasks.some(ownsWorkerRuntimeSurface);
  if (!plansRuntimeWork) return { passed: true, reason: 'ok' };

  return {
    passed: true,
    reason:
      'ok: root Worker scaffold is owned by the deterministic project factory and will be validated by the scaffold manifest gate before implementation.',
  };
}

export function legacyProjectScaffoldHygiene(repoPath: string, taskPlan: TaskPlan) {
  if (existsSync(join(repoPath, 'package.json'))) return { passed: true, reason: 'ok' };

  const plansRuntimeWork = taskPlan.tasks.some(ownsWorkerRuntimeSurface);
  if (!plansRuntimeWork) return { passed: true, reason: 'ok' };

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find(ownsPackageScaffold);
  if (!scaffoldRootTask) {
    return {
      passed: false,
      reason:
        'Target repo has no package.json. The task plan needs a root scaffold task that owns package.json, .gitignore, and a concrete Worker source entry before Worker runtime files so automated verification can run.',
    };
  }

  if (!ownsWorkerSourceInputSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns package.json but no Worker source input. Bare Worker scaffolds need an owned source surface such as src/index.js, workers/app.js, or src/index.ts before later tasks.`,
    };
  }

  if (ownsTypeScriptInputSurface(scaffoldRootTask) && !taskOwnsExactSurface(scaffoldRootTask, 'tsconfig.json')) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns TypeScript Worker source but not tsconfig.json. TypeScript Worker scaffolds need tsconfig.json so npm run typecheck can pass before later tasks.`,
    };
  }

  if (!workerConfigPath(repoPath) && !ownsWorkerConfigSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns the new Worker package scaffold but not wrangler.jsonc. New Worker scaffolds should include wrangler.jsonc in the root task so the first build slice can run Wrangler dry-run validation before downstream runtime tasks.`,
    };
  }

  const plannedTomlConfig = taskPlan.tasks.find((task) => taskOwnsExactSurface(task, 'wrangler.toml'));
  if (plannedTomlConfig && !existsSync(join(repoPath, 'wrangler.toml'))) {
    return {
      passed: false,
      reason: `${plannedTomlConfig.id} owns wrangler.toml, but this repo has no existing wrangler.toml. New Worker project plans should own wrangler.jsonc so config schema validation, bindings, and local Wrangler checks use the current JSONC config path.`,
    };
  }

  const unscaffoldedRootRuntimeTask = rootTasks.find((task) => ownsWorkerRuntimeSurface(task) && !ownsPackageScaffold(task));
  if (unscaffoldedRootRuntimeTask) {
    return {
      passed: false,
      reason: `${unscaffoldedRootRuntimeTask.id} owns Worker/runtime surfaces before the package scaffold. Make it depend_on ${scaffoldRootTask.id}, or include package.json and the Worker source entry in the same root scaffold task.`,
    };
  }

  return { passed: true, reason: 'ok' };
}
