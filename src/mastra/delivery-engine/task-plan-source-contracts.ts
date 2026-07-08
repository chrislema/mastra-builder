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
