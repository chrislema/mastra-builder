import { normalizeDeliveryPathReference } from './checks';
import type { Task } from './workflow-schemas';

const knownRootPathSurfaces = new Set([
  '.env.example',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'README.md',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
]);

export function looksLikeRepoPathReference(surface: string) {
  const path = normalizeDeliveryPathReference(surface);
  if (!path || /\s/.test(path)) return false;
  if (knownRootPathSurfaces.has(path)) return true;
  if (path.includes('/')) return true;
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(path);
}

export function normalizedOwnedSurfaces(task: Task) {
  return task.owned_surfaces.map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

export function concreteOwnedSurfacePath(surface: string) {
  const trimmed = normalizeDeliveryPathReference(surface);
  if (!trimmed || trimmed.includes('*') || /^unknown\b/i.test(trimmed)) return undefined;
  if (!looksLikeRepoPathReference(trimmed)) return undefined;
  return trimmed;
}

export function taskOwnedBoundaryPaths(task: Task) {
  return normalizedOwnedSurfaces(task).map(concreteOwnedSurfacePath).filter((path): path is string => Boolean(path));
}

export function taskOwnsPathMatching(task: Task, pattern: RegExp) {
  return taskOwnedBoundaryPaths(task).some((path) => pattern.test(path));
}

export function taskAcceptanceText(task: Task) {
  return [...task.acceptance_criteria, ...(task.source_acceptance_criteria ?? [])].join('\n');
}

function positiveTaskAcceptanceText(task: Task) {
  return taskAcceptanceText(task)
    .replace(/\b(?:it\s+)?does\s+not\s+introduce\b[^.\n]*/gi, '')
    .replace(/\bmust\s+not\s+(?:introduce|define|persist|include)\b[^.\n]*/gi, '')
    .replace(/\bno\s+(?:database|auth|server state|D1|Durable Objects|Queues|Workflows|server-side file uploads)\b[^.\n]*/gi, '');
}

export function taskOwnsRouterSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/);
}

export function taskOwnsRouteModule(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes(?:\/.*|[A-Z].*)?|[A-Za-z0-9_-]*(?:Routes|Handlers))\.[cm]?[jt]s$/i);
}

export function taskOwnsGenericRouteModule(task: Task) {
  return taskOwnsPathMatching(task, /^src\/routes\.[cm]?[jt]s$/i);
}

function genericRouteMentionsProfile(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bprofiles?\b/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsRuns(task: Task) {
  return (
    taskOwnsGenericRouteModule(task) &&
    /(?:\/runs(?:\b|\/|:)|\bmanual\/profile\/regeneration endpoints?\b|\bmanual endpoints?\b|\bmanual\s+runs?\b|\bqueued\s+(?:manual\s+)?run\b|\brun\s+(?:creation|detail|status|lifecycle|record|records|repository|transcript|history)\b|\bruns?\s+(?:route|routes|endpoint|endpoints|handler|handlers|repository|lifecycle|record|records))\b/i.test(
      positiveTaskAcceptanceText(task),
    )
  );
}

function genericRouteMentionsManualProfileRegeneration(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bmanual\/profile\/regeneration endpoints?\b/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsLatest(task: Task) {
  return (
    genericRouteMentionsManualProfileRegeneration(task) ||
    (taskOwnsGenericRouteModule(task) &&
      /(?:\/latest\b|\blatest\s+(?:route|routes|endpoint|endpoints|transcript|completed))/i.test(
        positiveTaskAcceptanceText(task),
      ))
  );
}

function genericRouteMentionsRegeneration(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\bregenerat/i.test(positiveTaskAcceptanceText(task));
}

function genericRouteMentionsCandidates(task: Task) {
  return taskOwnsGenericRouteModule(task) && /\b(?:candidate routes?|candidate endpoints?|\/candidates?)\b/i.test(positiveTaskAcceptanceText(task));
}

export function taskOwnsSessionRoute(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes\/session|sessionRoutes)\.[cm]?[jt]s$/i);
}

export function taskOwnsProfileRoute(task: Task) {
  return (
    genericRouteMentionsProfile(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*profiles?|routesProfiles|profile(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsProfileRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/profiles|profileRepository)\.[cm]?[jt]s$/i);
}

export function taskOwnsRunRoute(task: Task) {
  return (
    genericRouteMentionsRuns(task) ||
    genericRouteMentionsLatest(task) ||
    genericRouteMentionsRegeneration(task) ||
    genericRouteMentionsCandidates(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*(?:runs?|latest|regeneration|regenerate|candidates?)|routes(?:Runs?|Latest|Regeneration|Regenerate|Candidates?)|(?:run|latest|regeneration|regenerate|candidate)(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsManualRunRoute(task: Task) {
  return (
    genericRouteMentionsRuns(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*runs?|routesRuns?|run(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsLatestRoute(task: Task) {
  return (
    genericRouteMentionsLatest(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*latest|routesLatest|latest(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsRegenerationRoute(task: Task) {
  return (
    genericRouteMentionsRegeneration(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*(?:regeneration|regenerate)|routes(?:Regeneration|Regenerate)|regeneration(?:Routes|Handlers)|regenerate(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsCandidateRoute(task: Task) {
  return (
    genericRouteMentionsCandidates(task) ||
    taskOwnsPathMatching(task, /^src\/(?:routes\/.*candidates?|routesCandidates?|candidate(?:Routes|Handlers))\.[cm]?[jt]s$/i)
  );
}

export function taskOwnsRunRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/runs|runRepository)\.[cm]?[jt]s$/i);
}

export function taskOwnsTranscriptRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/transcripts|transcriptRepository)\.[cm]?[jt]s$/i);
}

export function taskOwnsWorkflowSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow|scheduler)\.[cm]?[jt]s$/i);
}

export function taskOwnsWorkflowExecutionSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:workflows\/)?weeklyWorkflow|workflow)\.[cm]?[jt]s$/i);
}

export function taskOwnsSchedulerSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/scheduler\.[cm]?[jt]s$/i);
}

export function taskOwnsContractSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:contracts|validation)\.[cm]?[jt]s$/i);
}

export function taskOwnsProviderAdapterSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/providers\.[cm]?[jt]s$/i);
}

export function taskOwnsAiValidationSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:aiJson|jsonOutput|aiValidation|aiSchemas?|schemas?)\.[cm]?[jt]s$/i);
}

export function taskOwnsAiPipelineSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:candidatePipeline|scoring|transcriptGenerator|prompts|aiClient)\.[cm]?[jt]s$/i);
}

export function taskOwnsProfileSummarySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:profileSummary|profileSummaryService)\.[cm]?[jt]s$/i);
}

export function taskOwnsAuthSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:http\/)?auth|adminAuth|sessionAuth)\.[cm]?[jt]s$/);
}

export function taskOwnsOperatorAuthBoundary(task: Task) {
  if (taskOwnsAuthSurface(task)) return true;
  if (!taskOwnsRouterSurface(task)) return false;
  return /\b(?:admin[-_\s]?token|Authorization:\s*Bearer|authorization checks?|credential checks?|secret check)\b/i.test(
    taskAcceptanceText(task),
  );
}

export function taskAuthBoundarySurface(task: Task) {
  return (
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?auth|adminAuth|sessionAuth)\.[cm]?[jt]s$/i.test(path)) ??
    taskOwnedBoundaryPaths(task).find((path) => /^src\/(?:(?:http\/)?router|http|routes)\.[cm]?[jt]s$/i.test(path)) ??
    'src/auth.js'
  );
}

export function taskOwnsPublicAppSurface(task: Task) {
  return taskOwnsPathMatching(task, /^public\/(?:index\.html|app\.js)$/);
}

export function taskOwnsIndexSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/index\.[cm]?[jt]s$/);
}

export function taskOwnsReadme(task: Task) {
  return taskOwnedBoundaryPaths(task).includes('README.md');
}
