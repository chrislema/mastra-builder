import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profileContractProducerSurfaces } from '../planning/profile-contract-policy';
import { sourcePolicyFromDocuments, sourcePolicyFromRepo } from '../source-policy';
import {
  concreteOwnedSurfacePath,
  effectiveOwnedSurfaces,
  taskOwnsD1MigrationFile,
} from '../task-plan-surface-policy';
import type { SourcePolicy, Task } from '../workflow-schemas';
import { taskBoundarySurfaces } from './task-boundaries';

const moduleSourceExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;

function firstExistingRepoPath(repoPath: string, candidates: string[]) {
  return candidates.find((candidate) => existsSync(join(resolve(repoPath), candidate)));
}

function workflowStepOwnedSurfaces(task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /^src\/workflows\/steps\/[^/]+\.[cm]?[jt]s$/.test(path) && !/\/index\.[cm]?[jt]s$/.test(path));
}

function workflowStepSlug(path: string) {
  return path.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '');
}

function workflowStepExportedNames(repoPath: string, stepPath: string) {
  const fullPath = join(resolve(repoPath), stepPath);
  if (!existsSync(fullPath)) return [];

  const source = readFileSync(fullPath, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  return [...names];
}

function withoutImportStatements(source: string) {
  return source.replace(/^\s*import\s+[\s\S]*?;\s*$/gm, '');
}

export function workflowStepIntegrationGaps(repoPath: string, task: Task) {
  const steps = workflowStepOwnedSurfaces(task);
  if (!steps.length) return [];

  const weeklySurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/workflows/weekly.${extension}`),
  );
  if (!weeklySurface) return [];

  const weeklyPath = join(resolve(repoPath), weeklySurface);
  const weeklySource = readFileSync(weeklyPath, 'utf8');
  const weeklyImplementationSource = withoutImportStatements(weeklySource);
  return steps
    .filter((step) => existsSync(join(resolve(repoPath), step)))
    .flatMap((step) => {
      const slug = workflowStepSlug(step);
      const exportedNames = workflowStepExportedNames(repoPath, step);
      const callsExportedStep = exportedNames.some((name) =>
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(weeklyImplementationSource),
      );
      if (slug && weeklySource.includes(`./steps/${slug}`) && callsExportedStep) return [];
      return [
        `Workflow step ${step} is not called from ${weeklySurface}; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.`,
      ];
    });
}

export function workflowEntrypointImportGaps(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /\.(?:[cm]?[jt]s)$/.test(path))
    .filter((path) => existsSync(join(resolve(repoPath), path)))
    .flatMap((path) => {
      const source = readFileSync(join(resolve(repoPath), path), 'utf8');
      if (!/\bextends\s+WorkflowEntrypoint\b/.test(source)) return [];
      if (/import\s*\{[^}]*\bWorkflowEntrypoint\b[^}]*\}\s*from\s*['"]cloudflare:workers['"]/.test(source)) return [];
      return [`${path} extends WorkflowEntrypoint but does not import WorkflowEntrypoint from cloudflare:workers.`];
    });
}

function routeOwnedSurfaces(task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => /^src\/routes\/[^/]+\.[cm]?[jt]s$/.test(path) && !/\/index\.[cm]?[jt]s$/.test(path));
}

export function routeMiddlewareBypassGaps(repoPath: string, task: Task) {
  const routeSurfaces = routeOwnedSurfaces(task);
  if (!routeSurfaces.length) return [];

  const indexSurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/index.${extension}`),
  );
  const routerSurface = firstExistingRepoPath(
    repoPath,
    moduleSourceExtensions.map((extension) => `src/http/router.${extension}`),
  );
  if (!indexSurface || !routerSurface) return [];

  const indexPath = join(resolve(repoPath), indexSurface);
  const indexSource = readFileSync(indexPath, 'utf8');
  if (!/\brouteRequest\s*\(/.test(indexSource)) return [];

  return routeSurfaces.flatMap((surface) => {
    const slug = surface.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '');
    if (!slug) return [];

    const routeImportPattern = new RegExp(
      `\\bfrom\\s+['"]\\.\\/routes\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.(?:js|mjs|cjs|ts|mts|cts))?['"]`,
    );
    if (!routeImportPattern.test(indexSource)) return [];

    return [
      `Route surface ${surface} is imported directly from ${indexSurface} while the existing routeRequest router is present; register it through the router/barrel/middleware path instead of dispatching before routeRequest.`,
    ];
  });
}

function repoTextIfExists(repoPath: string, path: string) {
  const fullPath = join(resolve(repoPath), path);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
}

function stringLiteralsFromText(text: string) {
  return Array.from(text.matchAll(/['"]([^'"]+)['"]/g)).map((match) => match[1]).filter(Boolean);
}

function validationProfileKinds(repoPath: string) {
  for (const path of profileContractProducerSurfaces) {
    const source = repoTextIfExists(repoPath, path);
    if (!source) continue;

    const arrayMatch = source.match(/\bPROFILE_KINDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\b/);
    if (arrayMatch) return stringLiteralsFromText(arrayMatch[1]);

    const typeMatch = source.match(/\bexport\s+type\s+ProfileKind\s*=\s*([\s\S]*?);/);
    if (typeMatch) return stringLiteralsFromText(typeMatch[1]);
  }

  return [];
}

function storageProfileKinds(repoPath: string) {
  const source = repoTextIfExists(repoPath, 'src/storage/profiles.ts');
  if (!source) return [];
  const match = source.match(/\bexport\s+type\s+Profile(?:Artifact)?Kind\s*=\s*([\s\S]*?);/);
  return match ? stringLiteralsFromText(match[1]) : [];
}

function migrationProfileKinds(repoPath: string) {
  const migrationsDir = join(resolve(repoPath), 'migrations');
  if (!existsSync(migrationsDir)) return [];

  const sources = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'));

  const source = sources.join('\n');
  if (!source) return [];
  const table = source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+profile_artifacts\s*\([\s\S]*?\n\);/i)?.[0] ?? source;
  const match = table.match(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i);
  return match ? stringLiteralsFromText(match[1]) : [];
}

function missingProfileKinds(expected: string[], actual: string[]) {
  if (!expected.length || !actual.length) return [];
  return expected.filter((kind) => !actual.includes(kind));
}

function taskOwnsProfileContractProducer(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return path ? profileContractProducerSurfaces.includes(path) : false;
  });
}

function taskOwnsProfileMigration(task: Task) {
  return taskOwnsD1MigrationFile(task);
}

function taskOwnsProfileStorage(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => concreteOwnedSurfacePath(surface) === 'src/storage/profiles.ts');
}

export function profileKindContractGaps(repoPath: string, task: Task) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  const requiredProfileKinds = sourcePolicy.requiredProfileKinds;
  const expected = validationProfileKinds(repoPath);
  const gaps: string[] = [];

  if (taskOwnsProfileContractProducer(task)) {
    if (requiredProfileKinds.length && !expected.length) {
      gaps.push(
        `Profile contract producer must export PROFILE_KINDS or ProfileKind with source-required profile kinds: ${requiredProfileKinds.join(', ')}.`,
      );
    } else if (requiredProfileKinds.length) {
      const missingRequired = missingProfileKinds(requiredProfileKinds, expected);
      if (missingRequired.length) {
        gaps.push(
          `Profile contract producer omits source-required profile kind(s): ${missingRequired.join(', ')}. Use the profile kind values declared by vision.md/spec.md; do not replace them with generic R2 artifact object categories.`,
        );
      }
    }
  }

  if (!expected.length) return gaps;

  if (taskOwnsProfileMigration(task)) {
    const missing = missingProfileKinds(expected, migrationProfileKinds(repoPath));
    if (missing.length) {
      gaps.push(
        `migrations/*.sql profile_artifacts.kind omits profile contract kind(s): ${missing.join(', ')}. Keep schema kind values aligned with PROFILE_KINDS or ProfileKind from the validation/domain profile contract.`,
      );
    }
  }

  if (taskOwnsProfileStorage(task)) {
    const missing = missingProfileKinds(expected, storageProfileKinds(repoPath));
    if (missing.length) {
      gaps.push(
        `src/storage/profiles.ts ProfileKind/ProfileArtifactKind omits profile contract kind(s): ${missing.join(', ')}. Storage profile metadata kind must match PROFILE_KINDS or ProfileKind from the validation/domain profile contract, not artifact object categories.`,
      );
    }
  }

  return gaps;
}

export function profileKindTaskPacketPolicy(sourcePolicy: SourcePolicy) {
  if (!sourcePolicy.requiredProfileKinds.length) return null;
  return {
    required_persistent_kinds: sourcePolicy.requiredProfileKinds,
    producer_surfaces: profileContractProducerSurfaces,
    guidance: 'Use the persistent profile kind values declared by the source docs. Do not substitute generic creator, voice, audience, topic, or R2 artifact object categories.',
  };
}

export function profileKindTaskPacketPolicyForTask(task: Task, sourcePolicy = sourcePolicyFromDocuments([])) {
  return (taskOwnsProfileContractProducer(task) || taskOwnsProfileMigration(task) || taskOwnsProfileStorage(task)) &&
    sourcePolicy.requiredProfileKinds.length
    ? profileKindTaskPacketPolicy(sourcePolicy)
    : null;
}

function sqlHasCheckConstraintForColumn(sql: string, column: string) {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`CHECK\\s*\\([^)]*\\b${escaped}\\b\\s+IN\\s*\\(`, 'i').test(sql);
}

export function lifecycleStatusSchemaGaps(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path && /\.sql$/i.test(path)))
    .flatMap((path) => {
      const fullPath = join(resolve(repoPath), path);
      if (!existsSync(fullPath)) return [];
      const sql = readFileSync(fullPath, 'utf8');
      const gaps: string[] = [];
      const statusColumnPattern = /^\s*([a-z_]*status)\s+TEXT\s+NOT\s+NULL\b([^,\n]*)/gim;
      for (const match of sql.matchAll(statusColumnPattern)) {
        const column = match[1];
        const definition = match[0];
        if (/\bCHECK\s*\(/i.test(definition) || sqlHasCheckConstraintForColumn(sql, column)) continue;
        gaps.push(`${path}:${column} is a lifecycle status column without a D1 CHECK constraint`);
      }
      return gaps;
    });
}
