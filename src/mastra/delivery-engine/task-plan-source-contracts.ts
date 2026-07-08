import type { SourcePolicy } from './workflow-schemas';

export const aiOutputValidationContract =
  'AI output validation treats model JSON as untrusted input: scores are bounded integers, required rationales and transcript fields are non-empty, sourceUrls are preserved from selected sources, primarySegment is supplied, and word counts are computed by code before persistence.';

export type SourceScopedDeliveryContracts = {
  profileState: boolean;
  latestTranscript: boolean;
};

export function sourceScopedDeliveryContracts(sourcePolicy?: SourcePolicy): SourceScopedDeliveryContracts {
  const legacyFixtureMode = !sourcePolicy;
  return {
    profileState: legacyFixtureMode || sourcePolicy.requiredProfileKinds.length > 0,
    latestTranscript: legacyFixtureMode || sourcePolicy.latestTranscriptRequired,
  };
}

export type RouteEndpointDefaultCriteriaFacts = {
  ownsProfileRoute: boolean;
  ownsManualRunRoute: boolean;
  ownsLatestRoute: boolean;
  ownsRegenerationRoute: boolean;
  ownsCandidateRoute: boolean;
};

export function routeEndpointDefaultCriteria(
  facts: RouteEndpointDefaultCriteriaFacts,
  contractScope: SourceScopedDeliveryContracts,
) {
  const criteria: string[] = [];

  if (contractScope.profileState && facts.ownsProfileRoute) {
    criteria.push(
      'POST /profiles accepts multipart/form-data uploads for audience_segments and voice_profile markdown, validates kind/content/size, persists the original markdown through the profile service boundary, and can set the uploaded profile active.',
      'POST /profiles/:id/activate atomically activates the selected profile for its kind, deactivates the previous active profile for that kind, and returns the active profile metadata without exposing raw markdown.',
      'GET /profiles returns profile metadata and active-state summaries for authenticated operators without exposing raw profile markdown or R2 object contents.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsManualRunRoute) {
    criteria.push(
      'POST /runs creates a queued manual run record with a default previous-seven-day window when no window is supplied, uses active profile artifact IDs when profile IDs are omitted, returns runId with status queued, and starts WEEKLY_WORKFLOW through the workflow binding/service boundary.',
      'GET /runs/:id returns run status, requested window, profile artifact IDs used, selected candidate ID, transcript ID, status/error details, and never exposes raw profile markdown or fetched source content.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsLatestRoute) {
    criteria.push(
      'GET /latest returns the latest completed transcript with title, hook, transcript, captions, sourceUrls, primarySegment, whyThisWasPicked, generatedAt, and run ID; it excludes completed_empty/no-transcript, failed, queued, and running runs and never exposes private profile markdown or fetched source content.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsRegenerationRoute) {
    criteria.push(
      'POST /runs/:id/regenerate creates a new transcript version for the selected run through the transcript generation/service boundary, preserves prior transcript rows, advances the current transcript pointer only when intended, and returns updated transcript metadata.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsCandidateRoute) {
    criteria.push(
      'Candidate routes for a run return candidate metadata and selection state without exposing private profile markdown or raw fetched source content, and candidate selection changes persist through the run/transcript repository boundary.',
    );
  }

  return criteria;
}

export function runRouteFamilyLabel(facts: RouteEndpointDefaultCriteriaFacts) {
  const families = [
    facts.ownsManualRunRoute ? 'run' : undefined,
    facts.ownsLatestRoute ? 'latest' : undefined,
    facts.ownsRegenerationRoute ? 'regeneration' : undefined,
    facts.ownsCandidateRoute ? 'candidate' : undefined,
  ].filter(Boolean);
  return families.length ? families.join(', ') : 'run';
}

export function runRouteMutationCriterion(facts: RouteEndpointDefaultCriteriaFacts) {
  const mutations = [
    facts.ownsManualRunRoute ? 'run creation' : undefined,
    facts.ownsRegenerationRoute ? 'regeneration' : undefined,
  ].filter(Boolean);
  if (!mutations.length) return undefined;
  return `Cookie-authenticated ${mutations.join(' and ')} mutations enforce the session CSRF token or same-origin Origin validation contract from the auth/session boundary.`;
}

export type TaskPlanSourceContractCriteriaFacts = RouteEndpointDefaultCriteriaFacts & {
  contractScope: SourceScopedDeliveryContracts;
  hasAuthBoundary: boolean;
  hasProfileState: boolean;
  hasAiValidationSurface: boolean;
  hasWorkerWorkflow: boolean;
  hasPersistentRunLifecycle: boolean;
  indexOwnerCount: number;
  ownsOperatorAuthBoundary: boolean;
  authSurface: string;
  authBoundaryIsInternalHelper: boolean;
  ownsPublicAppSurface: boolean;
  ownsD1MigrationFile: boolean;
  migrationSurface: string;
  ownsProfileRepositorySurface: boolean;
  ownsContractSurface: boolean;
  ownsRunRepositorySurface: boolean;
  ownsSchedulerSurface: boolean;
  ownsWorkflowExecutionSurface: boolean;
  isRootScaffold: boolean;
  workflowSurface: string;
  ownsRunRoute: boolean;
  ownsTranscriptRepositorySurface: boolean;
  ownsAiValidationSurface: boolean;
  ownsAiPipelineSurface: boolean;
  ownsRouterSurface: boolean;
  hasRouteIntegrationContract: boolean;
  ownsWorkerConfigFile: boolean;
  ownsIndexSurface: boolean;
  ownsReadme: boolean;
  sourceRouteEndpointCriteria: string[];
};

export function taskPlanSourceContractCriteria(facts: TaskPlanSourceContractCriteriaFacts) {
  const criteria: string[] = [];
  const { contractScope } = facts;

  if (facts.ownsOperatorAuthBoundary) {
    criteria.push(
      `${facts.authSurface} defines the protected operator credential contract as Authorization: Bearer <ADMIN_TOKEN> for API/operator calls, rejects missing or invalid credentials with structured 401/403 responses, fails closed when ADMIN_TOKEN is missing, and never reads committed or static secrets.`,
    );
    if (facts.authBoundaryIsInternalHelper) {
      criteria.push(
        `${facts.authSurface} is an internal credential-validation helper for operator APIs and the browser session exchange boundary; it does not make public/app.js persist, repeat, or directly send the raw ADMIN_TOKEN to feature mutation endpoints.`,
      );
    } else {
      criteria.push(
        `${facts.authSurface} provides a browser-safe auth/session boundary for the public UI: a dedicated session endpoint may exchange the operator credential for a short-lived HttpOnly SameSite cookie, and protected browser mutations must validate that session instead of requiring public/app.js to handle the raw ADMIN_TOKEN repeatedly.`,
        `${facts.authSurface} centralizes browser session validation for a stateless signed expiring session cookie: the cookie payload includes an expiration timestamp, is signed with WebCrypto HMAC using a separate SESSION_SECRET, fails closed when SESSION_SECRET is missing, rejects tampering and expired sessions, and never stores the raw ADMIN_TOKEN in the cookie.`,
        `${facts.authSurface} defines the browser mutation request-forgery guard for cookie-authenticated requests, using SameSite=Strict plus explicit Origin validation or CSRF token issuance and validation.`,
      );
    }
  }

  if (facts.hasAuthBoundary && facts.ownsPublicAppSurface) {
    criteria.push(
      'public/app.js uses the browser-safe auth/session flow for protected profile, run, activation, and regeneration calls; may accept the operator credential only transiently for the session login/exchange endpoint; discards it after the exchange; sends protected mutation requests with credentials included and the session CSRF token/header when required; handles unauthenticated responses; and never hardcodes, stores, persists, repeats, or sends the raw ADMIN_TOKEN directly to feature mutation endpoints.',
    );
  }

  if (facts.ownsD1MigrationFile && facts.hasProfileState) {
    criteria.push(
      `${facts.migrationSurface} enforces at most one active profile_artifacts row per kind with a D1/SQLite partial unique index where is_active = 1 and constrains valid profile kinds.`,
    );
  }

  if (contractScope.profileState && facts.ownsProfileRepositorySurface) {
    criteria.push(
      'Profile storage activation runs in a D1 transaction that deactivates the previous active profile for the same kind and activates the selected profile atomically.',
      'Profile repository persists derived_summary_r2_key updates only through the profile summary service boundary, preserving original profile markdown as the source of truth.',
    );
  }

  if (contractScope.profileState && facts.ownsProfileRoute) {
    criteria.push(
      'Profile upload and activation routes use the profile repository transaction for active-profile state changes instead of duplicating active-state authority in route code.',
      'Profile upload, profile activation, and profile listing routes use the auth/session boundary; for this single-user private MVP, GET /profiles must not expose private profile metadata without authentication.',
      'Cookie-authenticated profile mutations enforce the session CSRF token or same-origin Origin validation contract from the auth/session boundary.',
      'Profile upload or listing code delegates derived profile summary creation/loading to the profile summary service boundary instead of duplicating prompt or R2 update logic in route handlers.',
    );
  }

  if (facts.hasPersistentRunLifecycle && facts.ownsContractSurface) {
    criteria.push(
      'Run lifecycle contract defines the allowed state transitions queued -> running -> completed|completed_empty|failed, with route/scheduled code responsible for creating queued runs, workflow code responsible for running and terminal transitions, and latest-output queries excluding completed_empty/no-output runs deterministically.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsRunRepositorySurface) {
    criteria.push(
      'Run repository exposes idempotent transition helpers that enforce the run lifecycle contract and record exact profile artifact IDs used by a run before processing begins.',
    );
  }

  if (
    contractScope.latestTranscript &&
    facts.ownsSchedulerSurface &&
    !facts.ownsWorkflowExecutionSurface &&
    !facts.isRootScaffold
  ) {
    criteria.push(
      'Scheduled trigger handling creates or reuses queued run records and starts WEEKLY_WORKFLOW; scheduler code does not perform workflow execution, domain scoring, output generation, or terminal completed/completed_empty/failed transitions directly.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsWorkflowExecutionSurface && !facts.isRootScaffold) {
    criteria.push(
      `${facts.workflowSurface} owns workflow implementation logic consumed by the final src/index.js Worker entrypoint integration; it is not the configured Worker entry module unless this same task also owns src/index.js.`,
      'Scheduled triggers and manual run routes create queued run records only; workflow execution is the boundary that transitions queued runs to running and then completed or failed.',
      'Workflow treats an empty input/source item list as a completed_empty terminal run with no output artifact, records a no-input/no-output reason, and keeps latest-output lookup focused on completed runs with materialized outputs.',
      'Workflow execution receives or resumes a queued run, transitions it to running and then completed or failed, and does not create duplicate run records for the same workflow invocation.',
      'Workflow profile-loading steps call the profile summary service boundary to create or load derived summaries before prompt assembly, rather than owning derived_summary_r2_key state directly.',
    );
  }

  if (contractScope.latestTranscript && facts.ownsRunRoute) {
    criteria.push(
      `${runRouteFamilyLabel(facts)} route handlers delegate their owned run creation, lifecycle reads, latest transcript lookup, transcript versioning, or candidate selection behavior to service/repository boundaries instead of mutating D1 state directly in route handlers.`,
    );
    const mutationCriterion = runRouteMutationCriterion(facts);
    if (mutationCriterion) criteria.push(mutationCriterion);
  }

  if (contractScope.latestTranscript && (facts.ownsTranscriptRepositorySurface || facts.ownsRegenerationRoute)) {
    criteria.push(
      'Transcript regeneration inserts a new transcript row, preserves prior transcript rows, updates the run current transcript pointer only when intended, and keeps GET /latest deterministic for the latest completed run.',
    );
  }

  if (facts.ownsAiValidationSurface || (!facts.hasAiValidationSurface && facts.ownsAiPipelineSurface)) {
    criteria.push(aiOutputValidationContract);
  }

  if (facts.ownsRouterSurface) {
    criteria.push(
      'The router surface remains the single API route registration boundary; feature routes must be registered through the router rather than dispatched directly from src/index.js.',
    );
    if (facts.hasRouteIntegrationContract && (contractScope.profileState || contractScope.latestTranscript)) {
      criteria.push(
        'The router surface explicitly registers the browser session endpoint before UI work depends on it, so public/app.js can authenticate through the session route without handling raw ADMIN_TOKEN on feature mutations.',
        'Route integration defines and enforces the protection matrix: profile upload, profile activation, GET /profiles, manual runs, regeneration, and run detail endpoints are operator/session protected; GET /latest may be public only when it returns generated transcript fields and never raw profile markdown, profile history, or fetched source content.',
      );
    }
  }

  criteria.push(...routeEndpointDefaultCriteria(facts, contractScope));
  criteria.push(...facts.sourceRouteEndpointCriteria);

  if (
    contractScope.latestTranscript &&
    facts.hasWorkerWorkflow &&
    facts.isRootScaffold &&
    facts.ownsWorkerConfigFile &&
    facts.ownsIndexSurface
  ) {
    criteria.push(
      'src/index.js exports a minimal class named WeeklyWorkflow that extends WorkflowEntrypoint when wrangler.jsonc defines workflows.class_name "WeeklyWorkflow", so Wrangler dry-run validation succeeds before later workflow code fills in the implementation without changing the configured export name.',
    );
  }

  if (
    contractScope.latestTranscript &&
    facts.hasWorkerWorkflow &&
    facts.indexOwnerCount > 1 &&
    facts.ownsIndexSurface &&
    !facts.isRootScaffold
  ) {
    criteria.push(
      'src/index.js changes preserve the existing default fetch handler, scheduled handler wiring, static asset fallback path, and WeeklyWorkflow export introduced by earlier tasks.',
      'src/index.js preserves a stable WeeklyWorkflow export whose class name matches wrangler.jsonc workflows.class_name; later workflow code may fill in or delegate implementation details without changing the configured export.',
    );
  }

  if (facts.hasAuthBoundary && facts.ownsReadme) {
    criteria.push(
      'README.md documents direct Authorization: Bearer <ADMIN_TOKEN> API/operator access, the browser-safe signed session/cookie flow for the public UI, the required separate SESSION_SECRET for session signing, and states that secrets must not be committed or embedded in public assets.',
    );
  }

  return criteria;
}

export function routeIntegrationCriterion(routerSurface: string, routeNames: Array<string | undefined>) {
  return `${routerSurface} makes ${routeNames.join(', ')} routes reachable through the Worker fetch path without importing route modules directly into src/index.js.`;
}

export function sessionRouteCriteria(surface: string) {
  return [
    `${surface} implements a dedicated browser session endpoint for the public UI before profile/run UI work begins.`,
    `${surface} exchanges a valid operator credential for a short-lived HttpOnly SameSite cookie without persisting ADMIN_TOKEN in public assets, localStorage, sessionStorage, or query strings.`,
    `${surface} issues a stateless signed expiring session cookie whose payload includes an expiration timestamp, whose signature is verified with WebCrypto HMAC using a separate SESSION_SECRET, and whose validation fails closed when SESSION_SECRET is missing or when cookies are tampered or expired before protected route handlers run.`,
    `${surface} defines session validation and logout/status behavior, fails closed when ADMIN_TOKEN is missing, returns structured 401/403 responses for invalid credentials, and establishes the CSRF token or same-origin Origin validation contract used by cookie-authenticated browser mutations.`,
  ];
}
