import type {
  ReleaseGateHttpProbePlan,
  ReleaseGateProcessCommand,
  ReleaseGateRuntimeProbePlan,
} from './release-gate-probes';

export type ReleaseGatePublicAssetProbeFile = 'index.html' | 'styles.css' | 'app.js';

export type ReleaseGateRuntimeProbePlanningContext = {
  command: ReleaseGateProcessCommand | undefined;
  adminToken: string;
  publicAssetTextMarker: (file: ReleaseGatePublicAssetProbeFile) => string | undefined;
  healthRoutes: string[];
  hasRoute: (route: string) => boolean;
  latestTranscriptRequired: boolean;
  shortLinkLifecycleRequired: boolean;
  transcriptFixtureAvailable: boolean;
};

function releaseGateAdminHeaders(adminToken: string) {
  return { authorization: `Bearer ${adminToken}` };
}

function releaseGatePublicAssetProbe(
  context: ReleaseGateRuntimeProbePlanningContext,
  file: ReleaseGatePublicAssetProbeFile,
) {
  const route = file === 'index.html' ? '/' : `/${file}`;
  const marker = context.publicAssetTextMarker(file);
  if (!marker) return undefined;

  return {
    method: 'GET',
    path: route,
    expected: `GET ${route} serves public/${file} from Workers Static Assets.`,
    expectedStatus: 200,
    textContains: marker,
    reason: `public/${file} exists, so local Wrangler validation should prove the static asset is deployed and served by the Worker.`,
  } satisfies ReleaseGateHttpProbePlan;
}

const releaseGateLinkLifecycleDestination = 'https://example.com/mastra-release-gate';

function releaseGateHasLinkLifecycleRoutes(hasRoute: ReleaseGateRuntimeProbePlanningContext['hasRoute']) {
  return hasRoute('/api/links') && hasRoute('/api/links/') && hasRoute('/l/');
}

function releaseGateLinkLifecycleProbes(): ReleaseGateHttpProbePlan[] {
  return [
    {
      method: 'POST',
      path: '/api/links',
      expected: 'POST /api/links rejects malformed JSON with HTTP 400 and actionable JSON guidance.',
      expectedStatus: 400,
      body: { type: 'text', value: '{not-json', contentType: 'application/json' },
      textContains: 'next_steps',
      reason: 'The link creation route should fail closed on malformed JSON before touching D1.',
    },
    {
      method: 'POST',
      path: '/api/links',
      expected: 'POST /api/links rejects a missing destination URL with HTTP 400 and actionable JSON guidance.',
      expectedStatus: 400,
      body: { type: 'json', value: {} },
      textContains: 'next_steps',
      reason: 'The link creation route should validate required request fields.',
    },
    {
      method: 'POST',
      path: '/api/links',
      expected: 'POST /api/links rejects non-http destination URLs with HTTP 400 and actionable JSON guidance.',
      expectedStatus: 400,
      body: { type: 'json', value: { url: 'ftp://example.com/not-web' } },
      textContains: 'next_steps',
      reason: 'The link creation route should accept only http and https destinations.',
    },
    {
      method: 'GET',
      path: '/api/links',
      expected: 'GET /api/links returns an intentional JSON method error instead of a stack trace or HTML page.',
      expectedStatus: 405,
      textContains: 'next_steps',
      reason: 'Unsupported API methods should return explicit JSON errors.',
    },
    {
      method: 'POST',
      path: '/api/links',
      expected: 'POST /api/links creates a short link with a six-character URL-safe id and zero clicks.',
      expectedStatus: 201,
      body: { type: 'json', value: { url: releaseGateLinkLifecycleDestination } },
      jsonContains: { url: releaseGateLinkLifecycleDestination, clicks: 0 },
      jsonFieldMatches: { id: '^[A-Za-z0-9_-]{6}$' },
      captures: { releaseGateLinkId: 'id' },
      reason: 'A valid creation request should write D1 state and return the public link shape.',
    },
    {
      method: 'GET',
      path: '/api/links/{{releaseGateLinkId}}',
      expected: 'GET /api/links/:id returns the created link stats before any redirect.',
      expectedStatus: 200,
      jsonContains: { url: releaseGateLinkLifecycleDestination, clicks: 0 },
      jsonFieldsEqualVariables: { id: 'releaseGateLinkId' },
      reason: 'Stats lookup should read the just-created D1 record.',
    },
    {
      method: 'GET',
      path: '/l/{{releaseGateLinkId}}',
      expected: 'GET /l/:id redirects to the stored destination and increments the click count.',
      expectedStatus: 302,
      redirect: 'manual',
      headersContain: { location: releaseGateLinkLifecycleDestination },
      reason: 'Redirect behavior is the core public short-link path and should be proven against local D1 state.',
    },
    {
      method: 'GET',
      path: '/api/links/{{releaseGateLinkId}}',
      expected: 'GET /api/links/:id returns clicks incremented by exactly one after a redirect.',
      expectedStatus: 200,
      jsonContains: { url: releaseGateLinkLifecycleDestination, clicks: 1 },
      jsonFieldsEqualVariables: { id: 'releaseGateLinkId' },
      reason: 'Stats lookup after one redirect should prove atomic click counting.',
    },
    {
      method: 'GET',
      path: '/api/links/unknown-release-gate',
      expected: 'GET /api/links/:id returns an actionable JSON 404 for an unknown id.',
      expectedStatus: 404,
      jsonContains: { error: 'unknown link id' },
      textContains: 'next_steps',
      reason: 'Unknown stats lookups should fail closed with JSON guidance.',
    },
    {
      method: 'GET',
      path: '/l/unknown-release-gate',
      expected: 'GET /l/:id returns an actionable JSON 404 for an unknown id.',
      expectedStatus: 404,
      jsonContains: { error: 'unknown link id' },
      textContains: 'next_steps',
      reason: 'Unknown redirects should fail closed with JSON guidance instead of HTML or stack traces.',
    },
  ];
}

export function releaseGateRuntimeProbePlanRequiresAdminSecret(plan: ReleaseGateRuntimeProbePlan | undefined) {
  return Boolean(
    plan?.probes.some((probe) =>
      Object.keys(probe.headers ?? {}).some((header) => header.toLowerCase() === 'authorization'),
    ),
  );
}

export function buildReleaseGateRuntimeProbePlan(
  context: ReleaseGateRuntimeProbePlanningContext,
): ReleaseGateRuntimeProbePlan | undefined {
  if (!context.command) return undefined;

  const adminHeaders = releaseGateAdminHeaders(context.adminToken);
  const indexAssetProbe = releaseGatePublicAssetProbe(context, 'index.html');
  const defaultRootProbe: ReleaseGateHttpProbePlan = {
    method: 'GET',
    path: '/',
    expected: 'Local Worker runtime responds with an HTTP status below 500.',
    statusBelow: 500,
    reason: 'A non-5xx response proves wrangler dev started and can serve local Worker requests.',
  };

  const probes: ReleaseGateHttpProbePlan[] = [indexAssetProbe ?? defaultRootProbe];

  for (const assetProbe of [
    releaseGatePublicAssetProbe(context, 'styles.css'),
    releaseGatePublicAssetProbe(context, 'app.js'),
  ]) {
    if (assetProbe) probes.push(assetProbe);
  }

  for (const healthRoute of context.healthRoutes) {
    probes.push({
      method: 'GET',
      path: healthRoute,
      expected: `GET ${healthRoute} returns HTTP 200 JSON health status.`,
      expectedStatus: 200,
      jsonContainsAny: [{ status: 'ok' }, { ok: true }],
      reason: `A ${healthRoute} health route was present in the source tree.`,
    });
  }

  if (context.shortLinkLifecycleRequired && releaseGateHasLinkLifecycleRoutes(context.hasRoute)) {
    probes.push(...releaseGateLinkLifecycleProbes());
  }

  if (context.latestTranscriptRequired && context.hasRoute('/latest')) {
    if (context.transcriptFixtureAvailable) {
      probes.push({
        method: 'GET',
        path: '/latest',
        expected: 'GET /latest returns the seeded latest completed transcript from D1.',
        expectedStatus: 200,
        jsonContains: {
          title: 'Release Gate Regenerated Transcript',
          hook: 'Regenerated hook.',
          primarySegment: 'operators',
          whyThisWasPicked: 'Regenerated selection rationale.',
        },
        reason:
          'A latest transcript route and transcript schema were present, so release-gate fixture data proves completed transcript persistence and response shape.',
      });
    } else {
      probes.push({
        method: 'GET',
        path: '/latest',
        expected: 'GET /latest returns an actionable 404 when no completed transcript exists.',
        expectedStatus: 404,
        jsonContains: { error: 'no_transcript_available' },
        reason: 'A latest transcript route was present and should fail closed before any run has completed.',
      });
    }
  }

  if (context.latestTranscriptRequired && context.hasRoute('/runs')) {
    probes.push(
      {
        method: 'POST',
        path: '/runs',
        expected: 'POST /runs rejects invalid JSON with HTTP 400 and error "invalid_json".',
        expectedStatus: 400,
        headers: adminHeaders,
        body: { type: 'text', value: '{not-json', contentType: 'application/json' },
        jsonContains: { error: 'invalid_json' },
        reason: 'The run creation route was present and should give actionable malformed-body feedback.',
      },
      {
        method: 'POST',
        path: '/runs',
        expected: 'POST /runs without active profiles returns HTTP 409 and error "missing_active_profile".',
        expectedStatus: 409,
        headers: adminHeaders,
        body: { type: 'json', value: {} },
        jsonContains: { error: 'missing_active_profile' },
        reason: 'The run creation route depends on active profiles and should fail closed in a clean local state.',
      },
    );
  }

  if (context.latestTranscriptRequired && context.hasRoute('/profiles')) {
    probes.push(
      {
        method: 'POST',
        path: '/profiles',
        expected: 'POST /profiles rejects non-multipart requests with HTTP 400.',
        expectedStatus: 400,
        headers: adminHeaders,
        body: { type: 'json', value: { kind: 'audience_segments' } },
        jsonContains: { error: 'Request must be multipart/form-data' },
        reason: 'The profile upload route was present and should validate request shape before storage writes.',
      },
      {
        method: 'POST',
        path: '/profiles',
        expected: 'POST /profiles stores an active audience profile through D1 and R2.',
        expectedStatus: 201,
        headers: adminHeaders,
        body: {
          type: 'multipart-profile',
          kind: 'audience_segments',
          filename: 'audience-one.md',
          markdown: '# Audience\n\n- Segment: Founders\n- Pain: Need concise execution guidance.\n',
          setActive: true,
        },
        jsonContains: { kind: 'audience_segments', filename: 'audience-one.md', isActive: true },
        reason: 'A valid audience profile upload proves the route can write profile markdown to R2 and metadata to D1.',
      },
      {
        method: 'POST',
        path: '/profiles',
        expected: 'POST /profiles stores an active voice profile through D1 and R2.',
        expectedStatus: 201,
        headers: adminHeaders,
        body: {
          type: 'multipart-profile',
          kind: 'voice_profile',
          filename: 'voice.md',
          markdown: '# Voice\n\nDirect, practical, warm, with specific examples.\n',
          setActive: true,
        },
        jsonContains: { kind: 'voice_profile', filename: 'voice.md', isActive: true },
        reason: 'A valid voice profile upload proves both required profile kinds can be persisted.',
      },
      {
        method: 'POST',
        path: '/profiles',
        expected: 'Uploading a second active audience profile deactivates the first same-kind profile.',
        expectedStatus: 201,
        headers: adminHeaders,
        body: {
          type: 'multipart-profile',
          kind: 'audience_segments',
          filename: 'audience-two.md',
          markdown: '# Audience\n\n- Segment: Operators\n- Pain: Need repeatable systems.\n',
          setActive: true,
        },
        jsonContains: { kind: 'audience_segments', filename: 'audience-two.md', isActive: true },
        reason: 'Profile activation uniqueness is acceptance-critical for later run selection.',
      },
      {
        method: 'GET',
        path: '/profiles',
        expected: 'GET /profiles shows persisted profiles with one active audience profile and one active voice profile.',
        expectedStatus: 200,
        headers: adminHeaders,
        jsonArrayAssertions: [
          { type: 'minLength', min: 3 },
          { type: 'containsObject', where: { kind: 'audience_segments', filename: 'audience-one.md', isActive: false } },
          { type: 'containsObject', where: { kind: 'audience_segments', filename: 'audience-two.md', isActive: true } },
          { type: 'containsObject', where: { kind: 'voice_profile', filename: 'voice.md', isActive: true } },
          { type: 'countObjects', where: { kind: 'audience_segments', isActive: true }, count: 1 },
          { type: 'countObjects', where: { kind: 'voice_profile', isActive: true }, count: 1 },
        ],
        reason: 'Listing profiles after uploads verifies D1 persistence and same-kind activation state.',
      },
    );
  }

  return {
    tier: 'api',
    command: context.command,
    probes,
    required: true,
    reason: 'A Wrangler Worker config was present, so local runtime verification is required before deployment.',
  };
}
