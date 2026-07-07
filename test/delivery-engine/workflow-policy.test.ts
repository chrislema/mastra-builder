import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acceptanceContractsForTask,
  buildTimeoutRemediation,
  buildVerificationCommandPlan,
  canSalvageTimedOutBuildAttempt,
  createMissingOwnedSurfaceStubs,
  deliveryBuildResumePlan,
  deploymentReportSuccessNextSteps,
  directDependencySurfacePaths,
  implementationActionableJudgmentRemediation,
  implementationDeterministicResults,
  implementationDeterministicRemediation,
  implementationEnginePolicyMismatch,
  implementationFilesTouched,
  implementationFailureClass,
  implementationJudgmentCanComplete,
  implementationRetryMode,
  implementationToolChoiceForRetryMode,
  implementationWeakDimensionRemediation,
  isTrueBlockingAmbiguity,
  generatedSliceDependencyHygiene,
  judgeProviderErrorDetails,
  judgeUnavailableOutputForRubric,
  judgeUnavailableRemediation,
  latestSuccessfulWorkspaceWriteEventTimestamp,
  lifecycleStatusSchemaGaps,
  localDeploymentReportFromReleaseGateEvidence,
  configSchemaTaskSplitHygiene,
  normalizeTaskPlanLargeStorageTasks,
  normalizeTaskPlanConfigSchemaTasks,
  normalizeTaskPlanGeneratedSliceDependencies,
  normalizeTaskPlanOperatorDocumentation,
  normalizeTaskPlanCloudflareWorkerContracts,
  normalizeReadoutSafeAdapterAmbiguities,
  missingOwnedSurfacePaths,
  normalizeTaskPlanProfileContractDependencies,
  normalizeTaskPlanScaffoldDependencies,
  normalizeTaskPlanRoleBoundaries,
  operatorDocumentationHygiene,
  openDecisionHygiene,
  ownedSurfaceHygiene,
  pagesFunctionsExceptionHygiene,
  profileContractDependencyHygiene,
  profileKindContractGaps,
  profileKindTaskPacketPolicy,
  profileKindTaskPacketPolicyForTask,
  preserveTaskPlanAcceptanceContracts,
  outOfPlanVerificationFailurePaths,
  priorStoppedBuildTaskIds,
  productionDeploymentReportFromWranglerResult,
  productionWranglerDeployCommand,
  projectScaffoldHygiene,
  readBudgetBlockedToolCount,
  repairStaleDownstreamVerificationSurfaces,
  repairUnknownNumberIntegerNarrowing,
  releaseGateForInvalidTesterOutput,
  releaseGateEvidenceCommandPlan,
  releaseGateLocalAdminSecretPath,
  releaseGateLocalD1DatabaseName,
  releaseGateRuntimeProbePlan,
  releaseGateRuntimeProbePlanRequiresAdminSecret,
  releaseGateRequiredEvidencePassed,
  releaseGateRequiredStaticEvidenceFailures,
  releaseGateStaticEvidenceResults,
  releaseGateTranscriptFixtureSchemaGaps,
  releaseGateWorkerDeployDryRunCommand,
  releaseGateWorkerDevCommand,
  releaseGateWorkerStartupCheckCommand,
  releaseGateWorkerTypesCheckCommand,
  routeMiddlewareBypassGaps,
  reusableImplementationArtifactForTask,
  shouldProceedAfterNonActionableImplementationJudgment,
  shouldSuspendForPlannerQuestions,
  sourceDocumentsDeclareBookmarksService,
  sourceDocumentsDeclarePages,
  sourceDocumentsDeclareShortLinkLifecycle,
  sourceDocumentsDeclareTalkingHeadTranscriptContract,
  sourceDocumentsRequiredProfileKinds,
  staleDownstreamVerificationSurfacePaths,
  taskOwnedSurfaceRoleHygiene,
  taskPlanAcceptanceContractRegression,
  taskBoundarySurfaces,
  typeScriptDiagnosticsFromRemediation,
  typeScriptDiagnosticsFromText,
  unreplacedPreflightStubPaths,
  verificationWithAcceptanceGaps,
  workflowEntrypointImportGaps,
  workflowStepIntegrationGaps,
  workersAiBindingGaps,
  workerConfigHygieneGaps,
  workerEnvBindingAlignmentGaps,
  workerConfigTaskPacketPolicy,
  workerConfigTaskPacketPolicyForTask,
  workerPackageScaffoldGaps,
  wranglerConfigHasWorkersAiBinding,
} from '../../src/mastra/delivery-engine/workflow.ts';
import { aggregateJudgment, loadDeliveryEngineRubric } from '../../src/mastra/delivery-engine/judgment.ts';

const currentCompatibilityDate = () => new Date().toISOString().slice(0, 10);

function writeTalkingHeadSourceDocs(repoPath: string) {
  writeFileSync(
    join(repoPath, 'vision.md'),
    [
      '# Vision',
      'Talking Head Builder turns weekly bookmarks into one ready-to-record talking-head transcript.',
      'The creator uploads an audience segments profile and a voice profile.',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'spec.md'),
    [
      '# Spec',
      'ProfileArtifact.kind values are `audience_segments` and `voice_profile`.',
      'Fetch recent bookmarks through env.BOOKMARKS.',
      'Expose GET /latest for the latest TranscriptResult.',
      'Store runs, candidates, and transcripts for completed transcript regeneration.',
    ].join('\n'),
  );
}

const talkingHeadSourcePolicy = {
  pagesRequired: false,
  requiredProfileKinds: ['audience_segments', 'voice_profile'],
  talkingHeadTranscriptRequired: true,
  bookmarksServiceRequired: true,
};

const workerEnvironmentMirrorKeys = [
  'vars',
  'ai',
  'assets',
  'd1_databases',
  'durable_objects',
  'hyperdrive',
  'kv_namespaces',
  'queues',
  'r2_buckets',
  'services',
  'vectorize',
  'workflows',
];

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workerDeploymentEnvironments(config: Record<string, unknown> = {}) {
  const mirrored: Record<string, unknown> = {};
  for (const key of workerEnvironmentMirrorKeys) {
    if (config[key] !== undefined) mirrored[key] = cloneJsonValue(config[key]);
  }

  return {
    staging: cloneJsonValue(mirrored),
    production: cloneJsonValue(mirrored),
  };
}

function withWorkerDeploymentEnvironments(config: Record<string, unknown>) {
  return {
    ...config,
    env: workerDeploymentEnvironments(config),
  };
}

const readout = (blocking_ambiguities: string[]) => ({
  artifact_type: 'readout' as const,
  product_intent: 'intent',
  technical_shape: 'shape',
  safe_assumptions: [] as string[],
  blocking_ambiguities,
  recommended_next_step: 'next',
});

const taskPlan = (
  tasks: Array<{
    id?: string;
    owner?: 'engineer' | 'designer';
    depends_on: string[];
    acceptance_criteria?: string[];
    owned_surfaces?: string[];
  }>,
) => ({
  artifact_type: 'task-plan' as const,
  scope: 'scope',
  tasks: tasks.map((task, index) => ({
    id: task.id ?? `T${index + 1}`,
    owner: task.owner ?? ('engineer' as const),
    deliverable: 'deliverable',
    depends_on: task.depends_on,
    acceptance_criteria: task.acceptance_criteria ?? ['verified'],
    owned_surfaces: task.owned_surfaces ?? ['src/index.ts'],
  })),
  technology_decisions: [] as Array<{ decision: string; rationale: string }>,
  open_decisions: [] as string[],
  risks: [] as string[],
});

test('planner questions are deferred when a task plan has an executable root task', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(readout(['Confirm downstream integration detail.']), taskPlan([{ depends_on: [] }])),
    false,
  );
});

test('planner questions suspend only for source-document blockers when no executable root task exists', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(
      readout(['Implementation impossible: the spec explicitly marks the required upstream API contract TBD.']),
      taskPlan([]),
    ),
    true,
  );
  assert.equal(
    shouldSuspendForPlannerQuestions(
      readout(['Implementation impossible until the planner decides the first task shape.']),
      taskPlan([]),
    ),
    false,
  );
});

test('planner questions do not suspend for settled policy or preferences', () => {
  assert.equal(isTrueBlockingAmbiguity('Should this be React or vanilla HTML?'), false);
  assert.equal(isTrueBlockingAmbiguity('Should deployment use GitHub Actions or Wrangler?'), false);
  assert.equal(isTrueBlockingAmbiguity('Which accent color should the UI use?'), false);
  assert.equal(
    shouldSuspendForPlannerQuestions(
      readout(['Should this be Cloudflare Pages or Workers?', 'Which accent color should the UI use?']),
      taskPlan([]),
    ),
    false,
  );
});

test('planner readout normalization moves BOOKMARKS adapter ambiguity to safe assumptions', () => {
  const normalized = normalizeReadoutSafeAdapterAmbiguities(
    readout([
      'The exact BOOKMARKS service binding date-window API is not specified: the plan needs the endpoint path/RPC method, HTTP method, request parameters, and response envelope before the bookmark client can be wired safely.',
    ]),
  );

  assert.deepEqual(normalized.blocking_ambiguities, []);
  assert.match(normalized.safe_assumptions.join('\n'), /env\.BOOKMARKS\.fetch/);
  assert.match(normalized.safe_assumptions.join('\n'), /src\/bookmarkClient\.ts/);
});

test('task plan open decisions must be decision-shaped blockers', () => {
  const blockerPlan = taskPlan([{ depends_on: [] }]);
  blockerPlan.open_decisions = [
    [
      'Topic: BOOKMARKS service binding call shape',
      'Why it matters: blocks T7 bookmark fetch implementation because the workflow cannot know whether to call fetch or RPC safely',
      'Options considered: fetch with date-window query; RPC method with explicit window arguments',
      'Follow-up impact: T7 cannot be finalized until the binding contract is confirmed',
    ].join(' | '),
  ];

  assert.deepEqual(openDecisionHygiene(blockerPlan), { passed: true, reason: 'ok' });

  const futureTaskBlockerPlan = taskPlan([{ depends_on: [] }]);
  futureTaskBlockerPlan.open_decisions = [
    [
      'Topic: Bookmark service date-window contract',
      'Why it matters: Blocks T08 implementation of src/bookmarks/client.ts because the Worker must know whether to call env.BOOKMARKS.fetch() or an RPC method.',
      'Options considered: service-binding fetch endpoint with from/to query; RPC-style method; documented public HTTP fallback for local development.',
      'Follow-up impact: Resolve before T08 can be completed against the real bookmarks service; other tasks can proceed with the low-risk adapter boundary.',
    ].join(' | '),
  ];
  assert.deepEqual(openDecisionHygiene(futureTaskBlockerPlan), { passed: true, reason: 'ok' });

  const softDecisionPlan = taskPlan([{ depends_on: [] }]);
  softDecisionPlan.open_decisions = ['Whether the weekly cron should run on a specific day/time or simply every 7 days.'];
  assert.equal(openDecisionHygiene(softDecisionPlan).passed, false);
  assert.match(openDecisionHygiene(softDecisionPlan).reason, /not decision-shaped|safe assumption or risk/);

  const unblockedPlan = taskPlan([{ depends_on: [] }]);
  unblockedPlan.open_decisions = [
    [
      'Topic: Session duration',
      'Why it matters: product preference may change copy',
      'Options considered: 30 days; 7 days',
      'Follow-up impact: confirm only if product disagrees',
    ].join(' | '),
  ];
  assert.equal(openDecisionHygiene(unblockedPlan).passed, false);
  assert.match(openDecisionHygiene(unblockedPlan).reason, /safe assumption or risk|does not explain what implementation work it blocks/);

  const settledPolicyPlan = taskPlan([{ depends_on: [] }]);
  settledPolicyPlan.open_decisions = [
    [
      'Topic: Pages versus Workers',
      'Why it matters: blocks T1 because the project shape changes',
      'Options considered: Cloudflare Pages; standalone Workers',
      'Follow-up impact: T1 cannot scaffold until this is decided',
    ].join(' | '),
  ];
  assert.equal(openDecisionHygiene(settledPolicyPlan).passed, false);
  assert.match(openDecisionHygiene(settledPolicyPlan).reason, /settled delivery policy/);
});

test('task plan owned surfaces must be concrete repo paths or explicit unknowns', () => {
  const concretePlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml', 'src/index.ts', 'src/workflows/steps/fetch-bookmarks.ts', 'unknown: generated migration name depends on existing migration sequence'],
    },
  ]);
  assert.deepEqual(ownedSurfaceHygiene(concretePlan), { passed: true, reason: 'ok' });

  const conceptualPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler configuration', 'Worker Env types', 'Workflow binding registration'],
    },
  ]);
  const result = ownedSurfaceHygiene(conceptualPlan);
  assert.equal(result.passed, false);
  assert.match(result.reason, /conceptual surface/);

  const wildcardPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/storage/*.ts'],
    },
  ]);
  const wildcardResult = ownedSurfaceHygiene(wildcardPlan);
  assert.equal(wildcardResult.passed, false);
  assert.match(wildcardResult.reason, /wildcard surface/);
});

test('Pages Functions are allowed only when source docs declaratively require Pages', () => {
  assert.equal(
    sourceDocumentsDeclarePages([
      { path: 'vision.md', content: 'Build a Cloudflare Worker with vanilla public assets.' },
      { path: 'spec.md', content: 'No Pages Functions unless explicitly requested.' },
    ]),
    false,
  );
  assert.equal(
    sourceDocumentsDeclarePages([
      { path: 'vision.md', content: 'Should this be Cloudflare Pages or Workers?' },
      { path: 'spec.md', content: 'Default to standalone Workers.' },
    ]),
    false,
  );
  assert.equal(
    sourceDocumentsDeclarePages([
      { path: 'vision.md', content: 'Deployment: Cloudflare Pages. Use Pages Functions for API routes.' },
      { path: 'spec.md', content: 'The static site must stay on Pages.' },
    ]),
    true,
  );

  const pagesPlan = taskPlan([{ depends_on: [], owned_surfaces: ['functions/api/submit.js'] }]);
  assert.equal(
    pagesFunctionsExceptionHygiene(pagesPlan, {
      pagesRequired: false,
      requiredProfileKinds: [],
      talkingHeadTranscriptRequired: false,
      bookmarksServiceRequired: false,
    }).passed,
    false,
  );
  assert.match(
    pagesFunctionsExceptionHygiene(pagesPlan, {
      pagesRequired: false,
      requiredProfileKinds: [],
      talkingHeadTranscriptRequired: false,
      bookmarksServiceRequired: false,
    }).reason,
    /did not declaratively require Cloudflare Pages/,
  );
  assert.deepEqual(
    pagesFunctionsExceptionHygiene(pagesPlan, {
      pagesRequired: true,
      requiredProfileKinds: [],
      talkingHeadTranscriptRequired: false,
      bookmarksServiceRequired: false,
    }),
    { passed: true, reason: 'ok' },
  );
  assert.deepEqual(
    pagesFunctionsExceptionHygiene(taskPlan([{ depends_on: [], owned_surfaces: ['workers/submit.js'] }]), {
      pagesRequired: false,
      requiredProfileKinds: [],
      talkingHeadTranscriptRequired: false,
      bookmarksServiceRequired: false,
    }),
    { passed: true, reason: 'ok' },
  );
});

test('source docs declare product-specific profile and transcript policies', () => {
  const genericDocs = [
    { path: 'vision.md', content: 'Build a small Worker API with a GET /latest route for status.' },
    { path: 'spec.md', content: 'Use D1 for jobs. No creator profile artifacts are needed.' },
  ];
  assert.deepEqual(sourceDocumentsRequiredProfileKinds(genericDocs), []);
  assert.equal(sourceDocumentsDeclareTalkingHeadTranscriptContract(genericDocs), false);
  assert.equal(sourceDocumentsDeclareBookmarksService(genericDocs), false);
  assert.equal(sourceDocumentsDeclareShortLinkLifecycle(genericDocs), false);

  const talkingHeadDocs = [
    {
      path: 'vision.md',
      content: 'Talking Head Builder creates a ready-to-record talking-head transcript from weekly bookmarks.',
    },
    {
      path: 'spec.md',
      content:
        'ProfileArtifact.kind values are audience_segments and voice_profile. Expose GET /latest for the latest TranscriptResult.',
    },
    { path: 'spec.md', content: 'Fetch recent bookmarks through the BOOKMARKS service binding.' },
  ];
  assert.deepEqual(sourceDocumentsRequiredProfileKinds(talkingHeadDocs), ['audience_segments', 'voice_profile']);
  assert.equal(sourceDocumentsDeclareTalkingHeadTranscriptContract(talkingHeadDocs), true);
  assert.equal(sourceDocumentsDeclareBookmarksService(talkingHeadDocs), true);

  const shortLinkDocs = [
    { path: 'vision.md', content: 'Build a Cloudflare Worker URL shortener for customer short links.' },
    { path: 'spec.md', content: 'POST /api/links creates a link and GET /l/:id redirects to its destination.' },
  ];
  assert.equal(sourceDocumentsDeclareShortLinkLifecycle(shortLinkDocs), true);
  assert.equal(
    sourceDocumentsDeclareShortLinkLifecycle([
      { path: 'vision.md', content: 'Build a basic Worker API. No short links or URL shortener behavior.' },
      { path: 'spec.md', content: 'A stray /api/links route name in a note is not a product requirement.' },
    ]),
    false,
  );
});

test('bare Worker project plans require package scaffold before runtime surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-project-scaffold-'));
  const badPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml', 'src/env.ts', 'src/index.ts'],
    },
  ]);

  const badResult = projectScaffoldHygiene(repoPath, badPlan);
  assert.equal(badResult.passed, false);
  assert.match(badResult.reason, /no package\.json/);

  const packageOnlyPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.jsonc', 'src/index.js'],
    },
  ]);
  const packageOnlyResult = projectScaffoldHygiene(repoPath, packageOnlyPlan);
  assert.equal(packageOnlyResult.passed, false);
  assert.match(packageOnlyResult.reason, /no Worker source input/);

  const delayedConfigPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.jsonc'],
    },
  ]);
  const delayedConfigResult = projectScaffoldHygiene(repoPath, delayedConfigPlan);
  assert.equal(delayedConfigResult.passed, false);
  assert.match(delayedConfigResult.reason, /root task/);
  assert.match(delayedConfigResult.reason, /Wrangler dry-run validation/);

  const tsWithoutTsconfigPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.ts', 'wrangler.jsonc'],
    },
  ]);
  const tsWithoutTsconfigResult = projectScaffoldHygiene(repoPath, tsWithoutTsconfigPlan);
  assert.equal(tsWithoutTsconfigResult.passed, false);
  assert.match(tsWithoutTsconfigResult.reason, /TypeScript Worker source but not tsconfig\.json/);

  const tomlPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js', 'wrangler.toml'],
    },
  ]);
  const tomlResult = projectScaffoldHygiene(repoPath, tomlPlan);
  assert.equal(tomlResult.passed, false);
  assert.match(tomlResult.reason, /wrangler\.jsonc/);

  const goodPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js', 'wrangler.jsonc'],
    },
  ]);
  assert.deepEqual(projectScaffoldHygiene(repoPath, goodPlan), { passed: true, reason: 'ok' });
});

test('bare Worker project plans normalize root scaffold surfaces and static assets', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-project-scaffold-normalize-'));
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.jsonc'],
    },
    {
      depends_on: [],
      owned_surfaces: ['public/index.html', 'public/styles.css'],
    },
  ]);

  const normalized = normalizeTaskPlanScaffoldDependencies(repoPath, plan);

  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['package.json', 'src/index.js', '.gitignore', 'scripts/check-js.js']);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /\.delivery/);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /\*\.cpuprofile/);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /scripts\.typecheck exactly "node scripts\/check-js\.js"/);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T1']);
  assert.equal(projectScaffoldHygiene(repoPath, normalized).passed, false);
  assert.match(projectScaffoldHygiene(repoPath, normalized).reason, /root task/);
});

test('bare Worker project plans can auto-add missing root Wrangler config', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-project-scaffold-normalize-config-'));
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js'],
    },
    {
      depends_on: [],
      owned_surfaces: ['public/index.html', 'public/styles.css'],
    },
  ]);

  const normalized = normalizeTaskPlanScaffoldDependencies(repoPath, plan);

  assert.deepEqual(normalized.tasks[0].owned_surfaces, [
    'package.json',
    'src/index.js',
    '.gitignore',
    'wrangler.jsonc',
    'scripts/check-js.js',
  ]);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /Wrangler validation can run from the first build slice/);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /node --check/);
  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(projectScaffoldHygiene(repoPath, normalized), { passed: true, reason: 'ok' });
});

test('profile contract consumers normalize behind validation task', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/validation.ts'],
    },
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      depends_on: ['T2'],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
    {
      depends_on: ['T3'],
      owned_surfaces: ['src/routes/profiles.ts'],
    },
  ]);

  assert.equal(profileContractDependencyHygiene(plan).passed, false);

  const normalized = normalizeTaskPlanProfileContractDependencies(plan);

  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T2', 'T1']);
  assert.deepEqual(normalized.tasks[3].depends_on, ['T3', 'T1']);
  assert.deepEqual(profileContractDependencyHygiene(normalized), { passed: true, reason: 'ok' });
});

test('profile contract consumers normalize behind domain profile task', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain/profile.ts'],
    },
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      depends_on: ['T2'],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
  ]);

  const normalized = normalizeTaskPlanProfileContractDependencies(plan);

  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T2', 'T1']);
  assert.deepEqual(profileContractDependencyHygiene(normalized), { passed: true, reason: 'ok' });
});

test('focused repair dependency surfaces include direct task contract files', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/validation.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
    {
      depends_on: ['T1', 'T2'],
      owned_surfaces: ['src/routes/profiles.ts', 'src/index.ts'],
    },
  ]);

  assert.deepEqual(directDependencySurfacePaths(plan, plan.tasks[2]), ['src/validation.ts', 'src/storage/profiles.ts']);
});

test('profile kind contract drift is caught for schema and storage tasks', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-contract-'));
  mkdirSync(join(repoPath, 'src', 'storage'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'validation.ts'),
    'export const PROFILE_KINDS = ["speaker", "audience", "style"] as const;\n',
  );
  writeFileSync(
    join(repoPath, 'src', 'storage', 'profiles.ts'),
    "export type ProfileArtifactKind = 'profile_markdown' | 'profile_snapshot';\n",
  );
  writeFileSync(
    join(repoPath, 'migrations', '0001_schema.sql'),
    "CREATE TABLE IF NOT EXISTS profile_artifacts (\n  kind TEXT NOT NULL CHECK (kind IN ('profile_markdown', 'profile_snapshot'))\n);\n",
  );

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      depends_on: [],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /migrations\/\*\.sql.*speaker/);
  assert.match(profileKindContractGaps(repoPath, plan.tasks[1]).join('\n'), /src\/storage\/profiles\.ts.*speaker/);

  writeFileSync(
    join(repoPath, 'src', 'storage', 'profiles.ts'),
    "export type ProfileKind = 'speaker' | 'audience' | 'style';\n",
  );
  writeFileSync(
    join(repoPath, 'migrations', '0001_schema.sql'),
    "CREATE TABLE IF NOT EXISTS profile_artifacts (\n  kind TEXT NOT NULL CHECK (kind IN ('speaker', 'audience', 'style'))\n);\n",
  );

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[1]), []);
});

test('profile kind contract drift is caught for arbitrary migration filenames', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-migration-contract-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'domain.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );
  writeFileSync(
    join(repoPath, 'migrations', '0001_initial_schema.sql'),
    "CREATE TABLE IF NOT EXISTS profile_artifacts (\n  kind TEXT NOT NULL CHECK (kind IN ('profile_markdown', 'profile_snapshot'))\n);\n",
  );

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_initial_schema.sql'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /migrations\/\*\.sql.*audience_segments/);

  writeFileSync(
    join(repoPath, 'migrations', '0001_initial_schema.sql'),
    "CREATE TABLE IF NOT EXISTS profile_artifacts (\n  kind TEXT NOT NULL CHECK (kind IN ('audience_segments', 'voice_profile'))\n);\n",
  );

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
});

test('profile contract consumers normalize behind arbitrary migration tasks', () => {
  const plan = taskPlan([
    {
      id: 'T-domain',
      depends_on: [],
      owned_surfaces: ['src/domain.ts', 'src/validation.ts'],
    },
    {
      id: 'T-migration',
      depends_on: [],
      owned_surfaces: ['migrations/0001_initial_schema.sql'],
    },
  ]);

  assert.equal(profileContractDependencyHygiene(plan).passed, false);
  assert.deepEqual(normalizeTaskPlanProfileContractDependencies(plan).tasks[1].depends_on, ['T-domain']);
});

test('profile kind producer contract requires audience and voice profile kinds', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-producer-contract-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src', 'domain'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'domain', 'profileArtifacts.ts'), 'export const PROFILE_KINDS = ["creator"] as const;\n');

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain/profileArtifacts.ts'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /audience_segments, voice_profile/);
  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /source-required profile kind/);

  writeFileSync(
    join(repoPath, 'src', 'domain', 'profileArtifacts.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
});

test('profile kind contract treats profileKinds module as the producer surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-kinds-contract-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src', 'domain'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'domain', 'profileKinds.ts'),
    'export const PROFILE_KINDS = ["voice", "audience", "topic"] as const;\n',
  );

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain/profileKinds.ts'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /audience_segments, voice_profile/);

  writeFileSync(
    join(repoPath, 'src', 'domain', 'profileKinds.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
});

test('profile kind contract treats root domain module as the producer surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-root-domain-contract-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'domain.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain.ts', 'src/validation.ts'],
    },
  ]);

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);

  writeFileSync(
    join(repoPath, 'src', 'domain.ts'),
    'export const PROFILE_KINDS = ["voice", "audience", "topic"] as const;\n',
  );

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /audience_segments, voice_profile/);
});

test('profile kind contract treats root contracts module as the producer surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-root-contracts-contract-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'contracts.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );
  writeFileSync(join(repoPath, 'src', 'validation.ts'), 'import { PROFILE_KINDS } from "./contracts";\n');

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/contracts.ts', 'src/validation.ts'],
    },
  ]);

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
  assert.equal(profileKindTaskPacketPolicy(talkingHeadSourcePolicy)?.producer_surfaces.includes('src/contracts.ts'), true);
});

test('profile kind task packet policy names required persistent kinds', () => {
  assert.deepEqual(profileKindTaskPacketPolicy(talkingHeadSourcePolicy)?.required_persistent_kinds, [
    'audience_segments',
    'voice_profile',
  ]);
  assert.equal(profileKindTaskPacketPolicy(talkingHeadSourcePolicy)?.producer_surfaces.includes('src/domain/profileKinds.ts'), true);
  assert.match(profileKindTaskPacketPolicy(talkingHeadSourcePolicy)?.guidance ?? '', /Do not substitute generic/);
});

test('task packet policies are scoped to owning tasks', () => {
  const [scaffoldTask, configTask, profileTask] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts', 'src/env.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.jsonc'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['src/domain.ts', 'src/validation.ts'],
    },
  ]).tasks;

  assert.equal(workerConfigTaskPacketPolicyForTask(scaffoldTask), null);
  assert.equal(profileKindTaskPacketPolicyForTask(scaffoldTask), null);
  assert.equal(workerConfigTaskPacketPolicyForTask(configTask)?.schema, './node_modules/wrangler/config-schema.json');
  assert.equal(workerConfigTaskPacketPolicyForTask(configTask)?.compatibility_date, currentCompatibilityDate());
  assert.deepEqual(workerConfigTaskPacketPolicyForTask(configTask)?.deployment_environments.required, [
    'staging',
    'production',
  ]);
  assert.deepEqual(profileKindTaskPacketPolicyForTask(profileTask, talkingHeadSourcePolicy)?.required_persistent_kinds, [
    'audience_segments',
    'voice_profile',
  ]);
});

test('profile kind contract drift can use domain profile contract source', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-domain-contract-'));
  mkdirSync(join(repoPath, 'src', 'domain'), { recursive: true });
  mkdirSync(join(repoPath, 'src', 'storage'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src', 'domain', 'profile.ts'),
    'export const PROFILE_KINDS = ["speaker", "audience", "style"] as const;\n',
  );
  writeFileSync(join(repoPath, 'src', 'storage', 'profiles.ts'), "export type ProfileKind = 'speaker';\n");
  writeFileSync(
    join(repoPath, 'migrations', '0001_schema.sql'),
    "CREATE TABLE IF NOT EXISTS profile_artifacts (\n  kind TEXT NOT NULL CHECK (kind IN ('speaker'))\n);\n",
  );

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      depends_on: [],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /audience/);
  assert.match(profileKindContractGaps(repoPath, plan.tasks[1]).join('\n'), /audience/);
});

test('task plan role normalization strips designer-owned public surfaces from engineer scaffolds', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'wrangler.toml', 'src/index.ts', 'public/index.html'],
      acceptance_criteria: [
        'package.json exists with useful scripts.',
        'public/index.html can be served as the app shell.',
      ],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['public/index.html', 'public/styles.css', 'public/app.js'],
    },
  ]);
  plan.tasks[1].owner = 'designer';

  const normalized = normalizeTaskPlanRoleBoundaries(plan);

  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['package.json', 'tsconfig.json', 'wrangler.toml', 'src/index.ts']);
  assert.deepEqual(normalized.tasks[0].acceptance_criteria, ['package.json exists with useful scripts.']);
  assert.deepEqual(taskOwnedSurfaceRoleHygiene(normalized), { passed: true, reason: 'ok' });
});

test('task plan role hygiene rejects engineer-owned public surfaces without a designer owner', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts', 'public/index.html'],
    },
  ]);

  const result = taskOwnedSurfaceRoleHygiene(normalizeTaskPlanRoleBoundaries(plan));

  assert.equal(result.passed, false);
  assert.match(result.reason, /public\/index\.html|forbidden glob/);
});

test('task plan normalization splits oversized storage-only tasks and rewires downstream dependencies', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: [
        'src/storage/d1.ts',
        'src/storage/artifacts.ts',
        'src/storage/profiles.ts',
        'src/storage/runs.ts',
        'src/storage/bookmarks.ts',
        'src/storage/links.ts',
        'src/storage/candidates.ts',
        'src/storage/transcripts.ts',
      ],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['src/routes/profiles.ts'],
    },
  ]);

  const normalized = normalizeTaskPlanLargeStorageTasks(plan);

  assert.deepEqual(
    normalized.tasks.map((task) => task.id),
    ['T1', 'T1-part-2', 'T1-part-3', 'T1-part-4', 'T2'],
  );
  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['src/storage/d1.ts', 'src/storage/artifacts.ts']);
  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(normalized.tasks[1].owned_surfaces, ['src/storage/profiles.ts', 'src/storage/runs.ts']);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T1-part-2']);
  assert.deepEqual(normalized.tasks[2].owned_surfaces, ['src/storage/bookmarks.ts', 'src/storage/links.ts']);
  assert.deepEqual(normalized.tasks[3].depends_on, ['T1-part-3']);
  assert.deepEqual(normalized.tasks[3].owned_surfaces, ['src/storage/candidates.ts', 'src/storage/transcripts.ts']);
  assert.deepEqual(normalized.tasks[4].depends_on, ['T1-part-4']);
  assert.deepEqual(taskOwnedSurfaceRoleHygiene(normalized), { passed: true, reason: 'ok' });
});

test('generated implementation slices preserve source acceptance contracts', () => {
  const plan = taskPlan([
    {
      id: 'T11',
      depends_on: [],
      owned_surfaces: [
        'src/workflows/weeklyWorkflow.js',
        'src/scheduled.js',
        'src/workflows/steps/fetchBookmarks.js',
      ],
      acceptance_criteria: [
        'WeeklyWorkflow executes discrete steps for loading profiles, fetching bookmarks, generating transcript, and storing result.',
      ],
    },
  ]);

  const normalized = normalizeTaskPlanLargeStorageTasks(plan);

  assert.deepEqual(
    normalized.tasks.map((task) => task.id),
    ['T11', 'T11-part-2'],
  );
  for (const task of normalized.tasks) {
    assert.equal(task.source_task_id, 'T11');
    assert.deepEqual(task.source_acceptance_criteria, [
      'WeeklyWorkflow executes discrete steps for loading profiles, fetching bookmarks, generating transcript, and storing result.',
    ]);
  }
});

test('task plan revisions must not drop prior acceptance contracts', () => {
  const previous = taskPlan([
    {
      id: 'T11',
      depends_on: [],
      owned_surfaces: ['src/workflows/weeklyWorkflow.js', 'src/scheduled.js'],
      acceptance_criteria: [
        'WeeklyWorkflow creates or receives a run and executes discrete steps for loading profiles, fetching bookmarks, normalizing links, fetching content, extracting text, creating candidate briefs, scoring candidates, generating transcript, and storing result.',
        'Unrecoverable run-level failures mark the run failed with error_message.',
      ],
    },
  ]);
  const revised = taskPlan([
    {
      id: 'T11',
      depends_on: [],
      owned_surfaces: ['src/workflows/weeklyWorkflow.js', 'src/scheduled.js'],
      acceptance_criteria: [
        'Implement delivery slice 1/2: src/workflows/weeklyWorkflow.js, src/scheduled.js.',
        'src/scheduled.js starts the weekly run path using env.WEEKLY_WORKFLOW rather than running the full pipeline inside the scheduled handler.',
      ],
    },
    {
      id: 'T11-part-2',
      depends_on: ['T11'],
      owned_surfaces: ['src/index.js'],
      acceptance_criteria: ['src/index.js exports WeeklyWorkflow for Wrangler.'],
    },
  ]);

  const result = taskPlanAcceptanceContractRegression(previous, revised);

  assert.equal(result.passed, false);
  assert.match(result.reason, /dropped acceptance contract/);
  assert.match(result.reason, /loading profiles, fetching bookmarks/);

  (revised.tasks[0] as any).source_task_id = 'T11';
  (revised.tasks[0] as any).source_acceptance_criteria = previous.tasks[0].acceptance_criteria;
  assert.deepEqual(taskPlanAcceptanceContractRegression(previous, revised), { passed: true, reason: 'ok' });
});

test('task plan revision regression ignores generated slice bookkeeping criteria', () => {
  const previous = taskPlan([
    {
      id: 'T10-part-2',
      depends_on: ['T10'],
      owned_surfaces: ['src/routesRuns.js', 'src/scheduler.js'],
      acceptance_criteria: [
        'Implement delivery slice 2/2: src/routesRuns.js, src/scheduler.js.',
        'Replace any preflight stubs for this slice with real implementation code before returning.',
        'Keep this slice compatible with previously completed delivery slices and npm run typecheck.',
        'POST /runs creates a manual run and returns runId with status queued.',
      ],
    },
  ]);
  (previous.tasks[0] as any).source_task_id = 'T10';
  (previous.tasks[0] as any).source_acceptance_criteria = [
    'GET /runs/:id returns run status, window, profile IDs used, selectedCandidateId, and transcriptId.',
  ];
  const revised = taskPlan([
    {
      id: 'T10-part-2',
      depends_on: ['T10'],
      owned_surfaces: ['src/routesRuns.js', 'src/scheduler.js'],
      acceptance_criteria: [
        'Implement delivery slice 1/2: src/routesRuns.js, src/scheduler.js.',
        'POST /runs creates a manual run and returns runId with status queued.',
      ],
    },
  ]);
  (revised.tasks[0] as any).source_task_id = 'T10';
  (revised.tasks[0] as any).source_acceptance_criteria = [
    'GET /runs/:id returns run status, window, profile IDs used, selectedCandidateId, and transcriptId.',
  ];

  assert.deepEqual(taskPlanAcceptanceContractRegression(previous, revised), { passed: true, reason: 'ok' });

  (revised.tasks[0] as any).source_acceptance_criteria = [];
  const result = taskPlanAcceptanceContractRegression(previous, revised);
  assert.equal(result.passed, false);
  assert.match(result.reason, /GET \/runs\/:id returns run status/);
  assert.doesNotMatch(result.reason, /Implement delivery slice 2\/2/);
});

test('task plan revision normalization carries forward dropped product contracts', () => {
  const previous = taskPlan([
    {
      id: 'T03',
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
      acceptance_criteria: [
        'runs stores status, window boundaries, profile IDs used, selected candidate ID, transcript ID, error message, and timestamps.',
        'links captures per-link fetch status, content metadata, R2 keys, error message, and timestamps so one failed link does not fail a whole run.',
      ],
    },
  ]);
  const revised = taskPlan([
    {
      id: 'T03',
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
      acceptance_criteria: [
        'runs stores status, window boundaries, profile IDs used, selected candidate ID, transcript ID, error_message, and timestamps.',
        'links captures per-link fetch status, content metadata, R2 keys, error_message, and timestamps so one failed link does not fail a whole run.',
      ],
    },
  ]);

  assert.equal(taskPlanAcceptanceContractRegression(previous, revised).passed, false);

  const preserved = preserveTaskPlanAcceptanceContracts(previous, revised);

  assert.equal(preserved.carried, 2);
  assert.deepEqual(taskPlanAcceptanceContractRegression(previous, preserved.taskPlan), { passed: true, reason: 'ok' });
  assert.deepEqual(preserved.taskPlan.tasks[0].source_acceptance_criteria, previous.tasks[0].acceptance_criteria);
});

test('task plan normalization splits Worker config and D1 schema tasks', () => {
  const plan = taskPlan([
    {
      depends_on: ['T0'],
      acceptance_criteria: [
        'wrangler.jsonc registers DB and AI bindings.',
        'migrations/0001_schema.sql creates the D1 profile tables.',
        'src/index.ts reads the Env bindings.',
      ],
      owned_surfaces: ['wrangler.jsonc', 'migrations/0001_schema.sql', 'src/index.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['src/storage/profiles.ts'],
    },
  ]);

  assert.deepEqual(configSchemaTaskSplitHygiene(plan), {
    passed: false,
    reason:
      'T1 owns both Wrangler config and D1 migration files. Split Worker config and migrations into separate engineer tasks so config hygiene, SQL review, and Wrangler validation can repair independently.',
  });

  const normalized = normalizeTaskPlanConfigSchemaTasks(plan);

  assert.deepEqual(
    normalized.tasks.map((task) => task.id),
    ['T1', 'T1-d1-schema', 'T2'],
  );
  assert.deepEqual(normalized.tasks[0].depends_on, ['T0']);
  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['wrangler.jsonc', 'src/index.ts']);
  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(normalized.tasks[1].owned_surfaces, ['migrations/0001_schema.sql']);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T1-d1-schema']);
  assert.deepEqual(configSchemaTaskSplitHygiene(normalized), { passed: true, reason: 'ok' });
});

test('task plan normalization adds Cloudflare Worker auth, profile, router, and index contracts', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js', 'wrangler.jsonc'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/auth.js', 'src/router.js'],
      acceptance_criteria: [
        'src/auth.js centralizes browser session validation using SESSION_SECRET when configured or ADMIN_TOKEN as the fallback signing secret.',
      ],
    },
    {
      id: 'T03',
      depends_on: ['T02'],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      id: 'T04',
      depends_on: ['T03'],
      owned_surfaces: ['src/storage/profiles.js'],
    },
    {
      id: 'T05',
      depends_on: ['T04'],
      owned_surfaces: ['src/routes/profiles.js'],
    },
    {
      id: 'T06',
      depends_on: ['T05'],
      owned_surfaces: ['src/routes/runs.js', 'src/routes/latest.js'],
    },
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/scheduler.js', 'src/index.js'],
    },
    {
      id: 'T08',
      depends_on: ['T06'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      acceptance_criteria: [
        'public/app.js collects the admin token at runtime for protected profile, run, activation, and regeneration calls; sends Authorization: Bearer <ADMIN_TOKEN>; handles missing or invalid token responses; and never hardcodes secrets in public files.',
        'public/app.js supports admin token entry/storage for protected API calls.',
      ],
    },
    {
      id: 'T09',
      depends_on: ['T08'],
      owned_surfaces: ['README.md'],
      acceptance_criteria: [
        'README.md documents direct Authorization: Bearer <ADMIN_TOKEN> API/operator access, SESSION_SECRET when configured, and the ADMIN_TOKEN fallback signing behavior.',
      ],
    },
  ]);
  plan.tasks[7].owner = 'designer';

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const criteria = (id: string) => byId[id].acceptance_criteria.join('\n');
  const integration = normalized.tasks.find((task) => task.id === 'E98-route-integration');

  assert.match(criteria('T02'), /Authorization: Bearer <ADMIN_TOKEN>/);
  assert.match(criteria('T02'), /browser-safe auth\/session boundary/);
  assert.match(criteria('T02'), /stateless signed expiring session cookie/);
  assert.match(criteria('T02'), /separate SESSION_SECRET/);
  assert.doesNotMatch(criteria('T02'), /fallback signing secret/);
  assert.doesNotMatch(criteria('T02'), /ADMIN_TOKEN as the fallback/);
  assert.match(criteria('T03'), /partial unique index where is_active = 1/);
  assert.match(criteria('T04'), /D1 transaction/);
  assert.match(criteria('T05'), /repository transaction/);
  assert.match(criteria('T05'), /auth\/session boundary/);
  assert.match(criteria('T07'), /preserve the existing default fetch handler/);
  assert.match(criteria('T08'), /browser-safe auth\/session flow/);
  assert.match(criteria('T08'), /only transiently for the session login\/exchange endpoint/);
  assert.doesNotMatch(criteria('T08'), /collects the admin token at runtime/);
  assert.doesNotMatch(criteria('T08'), /admin token entry\/storage/);
  assert.match(criteria('T09'), /signed session\/cookie flow/);
  assert.match(criteria('T09'), /required separate SESSION_SECRET/);
  assert.doesNotMatch(criteria('T09'), /fallback signing behavior/);
  assert.ok(integration);
  assert.deepEqual(integration?.owned_surfaces, ['src/router.js']);
  assert.deepEqual(integration?.depends_on, ['T02', 'E20-auth-session', 'T05', 'T06']);
  assert.match(integration?.acceptance_criteria.join('\n') ?? '', /browser session/);
  assert.match(integration?.acceptance_criteria.join('\n') ?? '', /Every declared API endpoint is reachable through the router/);
  assert.match(integration?.acceptance_criteria.join('\n') ?? '', /protection matrix/);
  assert.ok(normalized.tasks.find((task) => task.id === 'E20-auth-session'));
  assert.ok(byId['E20-auth-session'].depends_on.includes('T01'));
  assert.match(criteria('E20-auth-session'), /stateless signed expiring session cookie/);
  assert.match(criteria('E20-auth-session'), /separate SESSION_SECRET/);
  assert.doesNotMatch(criteria('E20-auth-session'), /ADMIN_TOKEN as the fallback/);
});

test('task plan normalization keeps profile migration contracts on the owned migration filename', () => {
  const plan = taskPlan([
    {
      id: 'T03',
      depends_on: [],
      owned_surfaces: ['migrations/0001_initial_schema.sql'],
      acceptance_criteria: [
        'migrations/0001_schema.sql enforces at most one active profile_artifacts row per kind with a D1/SQLite partial unique index where is_active = 1 and constrains valid profile kinds.',
      ],
    },
    {
      id: 'T05',
      depends_on: ['T03'],
      owned_surfaces: ['src/routes/profiles.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const migrationTask = normalized.tasks.find((task) => task.id === 'T03');
  const criteria = migrationTask?.acceptance_criteria.join('\n') ?? '';

  assert.match(criteria, /migrations\/0001_initial_schema\.sql enforces at most one active profile_artifacts row/);
  assert.doesNotMatch(criteria, /migrations\/0001_schema\.sql enforces at most one active profile_artifacts row/);
});

test('task plan normalization adds a final Worker entrypoint integration task when only scaffold owns src/index.js', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/router.js', 'src/auth.js'],
    },
    {
      id: 'T03',
      depends_on: ['T02'],
      owned_surfaces: ['src/routes/runs.js'],
    },
    {
      id: 'T04',
      depends_on: ['T03'],
      owned_surfaces: ['src/scheduler.js'],
    },
    {
      id: 'T05',
      depends_on: ['T04'],
      owned_surfaces: ['src/workflow.js'],
    },
    {
      id: 'T06',
      depends_on: ['T03'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      owner: 'designer',
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const entrypoint = byId['E99-worker-entrypoint-integration'];
  const integration = byId['E98-route-integration'];

  assert.ok(entrypoint);
  assert.deepEqual(entrypoint.owned_surfaces, ['src/index.js']);
  assert.ok(entrypoint.depends_on.includes(integration.id));
  assert.ok(entrypoint.depends_on.includes('T04'));
  assert.ok(entrypoint.depends_on.includes('T05'));
  assert.match(entrypoint.acceptance_criteria.join('\n'), /delegates fetch handling to src\/router\.js/);
  assert.match(entrypoint.acceptance_criteria.join('\n'), /exports the real WeeklyWorkflow implementation/);
});

test('task plan normalization does not declare candidate routes without an owned candidate route', () => {
  const plan = taskPlan([
    {
      id: 'T02',
      depends_on: [],
      owned_surfaces: ['src/router.js', 'src/auth.js'],
    },
    {
      id: 'T03',
      depends_on: ['T02'],
      owned_surfaces: ['src/routes/runs.js', 'src/routes/latest.js', 'src/routes/regenerate.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const integration = normalized.tasks.find((task) => task.id === 'E98-route-integration');

  assert.ok(integration);
  assert.doesNotMatch(integration.acceptance_criteria.join('\n'), /candidate/);
  assert.match(integration.acceptance_criteria.join('\n'), /run, latest, regenerate/);
});

test('task plan normalization recognizes flat Worker http and route module names', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'src/index.js', 'wrangler.jsonc'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/contracts.js', 'src/validation.js'],
    },
    {
      id: 'T03',
      depends_on: ['T02'],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
    {
      id: 'T04',
      depends_on: ['T02'],
      owned_surfaces: ['src/http/auth.js', 'src/http.js'],
    },
    {
      id: 'T05',
      depends_on: ['T03'],
      owned_surfaces: ['src/profileRepository.js', 'src/runRepository.js', 'src/transcriptRepository.js'],
    },
    {
      id: 'T06',
      depends_on: ['T04', 'T05'],
      owned_surfaces: ['src/profileRoutes.js'],
    },
    {
      id: 'T07',
      depends_on: ['T05'],
      owned_surfaces: ['src/aiJson.js', 'src/candidatePipeline.js', 'src/transcriptGenerator.js'],
    },
    {
      id: 'T08',
      depends_on: ['T06', 'T07'],
      owned_surfaces: ['src/runRoutes.js', 'src/latestRoutes.js', 'src/regenerationRoutes.js'],
    },
    {
      id: 'T09',
      depends_on: ['T08'],
      owned_surfaces: ['src/weeklyWorkflow.js', 'src/index.js'],
    },
    {
      id: 'T10',
      depends_on: ['T08'],
      owned_surfaces: ['public/app.js'],
      acceptance_criteria: [
        'public/app.js calls protected endpoints with admin-token handling compatible with the Worker API boundary.',
      ],
      owner: 'designer',
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const criteria = (id: string) => byId[id].acceptance_criteria.join('\n');
  const integration = normalized.tasks.find((task) => task.id === 'E98-route-integration');

  assert.match(criteria('T02'), /Run lifecycle contract defines/);
  assert.match(criteria('T04'), /browser-safe auth\/session boundary/);
  assert.match(criteria('T05'), /idempotent transition helpers/);
  assert.match(criteria('T05'), /Transcript regeneration inserts/);
  assert.match(criteria('T06'), /profile listing routes use the auth\/session boundary/);
  assert.match(criteria('T07'), /AI output validation treats model JSON as untrusted input/);
  assert.match(criteria('T08'), /instead of mutating D1 state directly in route handlers/);
  assert.match(criteria('T09'), /stable WeeklyWorkflow export/);
  assert.match(criteria('T10'), /browser-safe auth\/session flow/);
  assert.doesNotMatch(criteria('T10'), /admin-token handling compatible/);
  assert.ok(integration);
  assert.deepEqual(integration?.owned_surfaces, ['src/http.js']);
  assert.deepEqual(integration?.depends_on, ['T04', 'E20-auth-session', 'T06', 'T08']);
  assert.deepEqual(byId.T10.depends_on, ['T08', 'E20-auth-session', 'E98-route-integration']);
});

test('task plan normalization keeps existing auth session before generated route slices', () => {
  const plan = taskPlan([
    {
      id: 'T12',
      depends_on: ['T11-part-2'],
      owned_surfaces: ['src/auth.js', 'src/router.js'],
    },
    {
      id: 'T12-part-2',
      depends_on: ['T12'],
      owned_surfaces: ['src/profileRoutes.js', 'src/runRoutes.js'],
    },
    {
      id: 'T12-part-3',
      depends_on: ['T12-part-2'],
      owned_surfaces: ['src/latestRoutes.js', 'src/index.js'],
    },
    {
      id: 'E20-auth-session',
      depends_on: ['T12-part-3'],
      owned_surfaces: ['src/sessionRoutes.js'],
    },
    {
      id: 'T13',
      depends_on: ['T12-part-3'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      owner: 'designer',
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));

  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T12']);
  assert.deepEqual(byId['T12-part-2'].depends_on, ['T12', 'E20-auth-session']);
  assert.deepEqual(byId['T12-part-3'].depends_on, ['T12-part-2', 'T12', 'E20-auth-session']);
  assert.deepEqual(byId.T13.depends_on, ['T12-part-3', 'E20-auth-session', 'E98-route-integration']);
});

test('task plan normalization injects session auth before late admin auth and route consumers', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/contracts.js', 'src/http.js'],
    },
    {
      id: 'T02-part-2',
      depends_on: ['T02'],
      owned_surfaces: ['src/validation.js', 'src/ids.js'],
    },
    {
      id: 'T02-part-3',
      depends_on: ['T02-part-2'],
      owned_surfaces: ['src/time.js'],
    },
    {
      id: 'T07',
      depends_on: ['T02-part-3'],
      owned_surfaces: ['src/profileRoutes.js'],
    },
    {
      id: 'T08',
      depends_on: ['T07'],
      owned_surfaces: ['src/adminAuth.js', 'src/runService.js'],
    },
    {
      id: 'T08-part-2',
      depends_on: ['T08', 'T02-part-3'],
      owned_surfaces: ['src/runRoutes.js', 'src/index.js'],
    },
    {
      id: 'T11',
      depends_on: ['T08-part-2'],
      owned_surfaces: ['src/weeklyWorkflow.js', 'src/index.js'],
      acceptance_criteria: [
        'WeeklyWorkflow creates or loads a run and marks it running with window_start and window_end.',
        'Workflow fetches bookmarks for the rolling seven-day or requested window and treats an empty list as a completed run with no transcript.',
      ],
    },
    {
      id: 'T12',
      depends_on: ['T08-part-2'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      owner: 'designer',
    },
    {
      id: 'T13',
      depends_on: ['T11', 'T12'],
      owned_surfaces: ['README.md'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const indexOf = (id: string) => normalized.tasks.findIndex((task) => task.id === id);
  const criteria = (id: string) => byId[id].acceptance_criteria.join('\n');

  assert.ok(byId['E20-auth-session']);
  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T01', 'T02-part-3']);
  assert.ok(indexOf('E20-auth-session') < indexOf('T07'));
  assert.deepEqual(byId.T07.depends_on, ['T02-part-3', 'E20-auth-session']);
  assert.deepEqual(byId['T08-part-2'].depends_on, ['T08', 'T02-part-3', 'E20-auth-session']);
  assert.deepEqual(byId['E98-route-integration'].depends_on, [
    'T02-part-3',
    'E20-auth-session',
    'T07',
    'T08-part-2',
  ]);
  assert.ok(indexOf('E98-route-integration') > indexOf('T08-part-2'));
  assert.ok(indexOf('E98-route-integration') < indexOf('T11'));
  assert.ok(indexOf('E98-route-integration') < indexOf('T12'));
  assert.deepEqual(byId.T12.depends_on, ['T08-part-2', 'E20-auth-session', 'E98-route-integration']);
  assert.match(criteria('T01'), /class named WeeklyWorkflow/);
  assert.match(criteria('T02'), /completed\|completed_empty\|failed/);
  assert.doesNotMatch(criteria('T08'), /provides a browser-safe auth\/session boundary/);
  assert.match(criteria('T08'), /internal credential-validation helper/);
  assert.doesNotMatch(criteria('T11'), /creates or loads a run and marks it running/);
  assert.doesNotMatch(criteria('T11'), /completed run with no transcript/);
  assert.match(criteria('T11'), /completed_empty terminal run/);
});

test('task plan normalization keeps session auth before route-bearing auth and late router tasks', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/contracts.js', 'src/http.js'],
    },
    {
      id: 'T02-part-2',
      depends_on: ['T02'],
      owned_surfaces: ['src/errors.js', 'src/ids.js'],
    },
    {
      id: 'T02-part-3',
      depends_on: ['T02-part-2'],
      owned_surfaces: ['src/timeWindow.js'],
    },
    {
      id: 'T05',
      depends_on: ['T02-part-3'],
      owned_surfaces: ['src/profileRoutes.js'],
    },
    {
      id: 'T10',
      depends_on: ['T02-part-3'],
      owned_surfaces: ['src/auth.js', 'src/runRoutes.js'],
    },
    {
      id: 'T10-part-2',
      depends_on: ['T10', 'T02-part-3'],
      owned_surfaces: ['src/latestRoutes.js', 'src/regenerateRoutes.js'],
    },
    {
      id: 'T11',
      depends_on: ['T05', 'T10-part-2'],
      owned_surfaces: ['src/index.js', 'src/router.js'],
    },
    {
      id: 'T12',
      owner: 'designer',
      depends_on: ['T10-part-2'],
      owned_surfaces: ['public/index.html', 'public/styles.css', 'public/app.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));

  assert.ok(byId['E20-auth-session']);
  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T01', 'T02-part-3']);
  assert.deepEqual(byId.T10.depends_on, ['T02-part-3', 'E20-auth-session']);
  assert.deepEqual(byId['T10-part-2'].depends_on, ['T10', 'T02-part-3', 'E20-auth-session']);
  assert.ok(byId['E98-route-integration'].depends_on.includes('T10-part-2'));
  assert.deepEqual(generatedSliceDependencyHygiene(normalized), { passed: true, reason: 'ok' });
});

test('task plan normalization keeps session auth before mixed router handler tasks', () => {
  const plan = taskPlan([
    {
      id: 'T04',
      depends_on: ['T02'],
      owned_surfaces: ['src/auth.js', 'src/http.js'],
    },
    {
      id: 'T11',
      depends_on: ['T04'],
      owned_surfaces: ['src/router.js', 'src/runHandlers.js'],
    },
    {
      id: 'T11-part-2',
      depends_on: ['T11'],
      owned_surfaces: ['src/latestHandlers.js', 'src/index.js'],
    },
    {
      id: 'T12',
      depends_on: ['T11-part-2'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      owner: 'designer',
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const indexOf = (id: string) => normalized.tasks.findIndex((task) => task.id === id);

  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T04']);
  assert.ok(indexOf('E20-auth-session') < indexOf('T11'));
  assert.deepEqual(byId.T11.depends_on, ['T04', 'E20-auth-session']);
  assert.deepEqual(byId['T11-part-2'].depends_on, ['T11', 'T04', 'E20-auth-session']);
});

test('task plan normalization keeps session auth before mixed auth and route tasks', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T07',
      depends_on: ['T01'],
      owned_surfaces: ['src/auth.js', 'src/routes/profiles.js'],
    },
    {
      id: 'T09',
      depends_on: ['T07'],
      owned_surfaces: ['src/routes/runs.js'],
    },
    {
      id: 'T13',
      depends_on: ['T09'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
      owner: 'designer',
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));

  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T01']);
  assert.ok(byId.T07.depends_on.includes('E20-auth-session'));
  assert.ok(byId.T09.depends_on.includes('E20-auth-session'));
});

test('task plan normalization attaches Worker lifecycle contracts to workflow and scheduler files', () => {
  const plan = taskPlan([
    {
      id: 'T11',
      depends_on: ['T10'],
      owned_surfaces: ['src/workflow.js', 'src/scheduler.js'],
      acceptance_criteria: [
        'weeklyWorkflow.js implements workflow steps including "create run" before fetching bookmarks.',
        'Workflow fetches bookmarks and treats an empty list as a completed run with no transcript.',
      ],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const criteria = normalized.tasks[0].acceptance_criteria.join('\n');

  assert.match(criteria, /manual run routes create queued run records only/);
  assert.match(criteria, /transitions queued runs to running and then completed or failed/);
  assert.doesNotMatch(criteria, /create run/);
  assert.doesNotMatch(criteria, /completed run with no transcript/);
  assert.match(criteria, /completed_empty terminal run/);
});

test('task plan normalization keeps scheduler-only slices out of workflow terminal-state ownership', () => {
  const plan = taskPlan([
    {
      id: 'T08-part-2',
      depends_on: ['T08'],
      owned_surfaces: ['src/regenerateRoutes.js', 'src/scheduler.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const criteria = normalized.tasks[0].acceptance_criteria.join('\n');

  assert.match(criteria, /starts WEEKLY_WORKFLOW/);
  assert.doesNotMatch(criteria, /completed_empty terminal run/);
  assert.doesNotMatch(criteria, /transitions queued runs to running and then completed or failed/);
});

test('task plan normalization promotes route source endpoint contracts into task-local acceptance criteria', () => {
  const plan = taskPlan([
    {
      id: 'T11-part-2',
      depends_on: ['T11'],
      owned_surfaces: ['src/routes/regenerate.js', 'src/routes/candidates.js'],
    },
  ]);
  (plan.tasks[0] as any).source_acceptance_criteria = [
    'POST /runs/:id/regenerate stores a new transcript version without losing prior transcript versions and delegates state mutation to service/repository boundaries.',
    'GET /runs/:id/candidates returns candidate briefs and scores through the auth/session protected route.',
  ];

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const criteria = normalized.tasks[0].acceptance_criteria.join('\n');

  assert.match(criteria, /POST \/runs\/:id\/regenerate stores a new transcript version/);
  assert.match(criteria, /GET \/runs\/:id\/candidates returns candidate briefs/);
});

test('task plan normalization scopes copied endpoint contracts to the owning route slice', () => {
  const sourceContracts = [
    'POST /runs creates a manual run with a default seven-day window when windowDays is omitted.',
    'GET /runs/:id returns run status, window, profile IDs, selected candidate ID, and transcript ID.',
    'GET /latest returns the latest completed transcript with title, hook, transcript, captions, sourceUrls, primarySegment, and whyThisWasPicked.',
    'POST /runs/:id/regenerate regenerates a transcript for the selected candidate or provided candidate ID using the stored profile versions and optional instruction.',
  ];
  const plan = taskPlan([
    {
      id: 'T08',
      depends_on: ['T07'],
      owned_surfaces: ['src/runRoutes.js', 'src/latestRoutes.js'],
    },
    {
      id: 'T08-part-2',
      depends_on: ['T08'],
      owned_surfaces: ['src/regenerateRoutes.js', 'src/scheduler.js'],
    },
  ]);
  (plan.tasks[0] as any).source_acceptance_criteria = sourceContracts;
  (plan.tasks[1] as any).source_acceptance_criteria = sourceContracts;

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const firstSliceCriteria = byId.T08.acceptance_criteria.join('\n');
  const secondSliceCriteria = byId['T08-part-2'].acceptance_criteria.join('\n');

  assert.match(firstSliceCriteria, /POST \/runs creates a manual run/);
  assert.match(firstSliceCriteria, /GET \/latest returns/);
  assert.doesNotMatch(firstSliceCriteria, /POST \/runs\/:id\/regenerate/);
  assert.doesNotMatch(firstSliceCriteria, /Transcript regeneration inserts/);
  assert.doesNotMatch(firstSliceCriteria, /candidate, and regeneration routes/);
  assert.match(secondSliceCriteria, /POST \/runs\/:id\/regenerate/);
  assert.doesNotMatch(secondSliceCriteria, /GET \/latest returns/);
  assert.match(secondSliceCriteria, /Transcript regeneration inserts/);
});

test('task plan normalization recognizes camel route files and removes boundary authority drift', () => {
  const sourceContracts = [
    'POST /runs creates a manual run and returns runId with status queued.',
    'GET /runs/:id returns run status, window, profile IDs used, selectedCandidateId, and transcriptId.',
    'GET /latest returns the latest completed transcript with title, hook, transcript, captions, sourceUrls, primarySegment, and whyThisWasPicked.',
    'POST /runs/:id/regenerate regenerates a transcript for the selected candidate.',
  ];
  const plan = taskPlan([
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/runPipeline.js'],
      acceptance_criteria: ['src/runPipeline.js creates a run with a default previous-seven-days window.'],
    },
    {
      id: 'T08-part-2',
      depends_on: ['T08'],
      owned_surfaces: ['src/routesRuns.js'],
    },
    {
      id: 'T08-part-3',
      depends_on: ['T08-part-2'],
      owned_surfaces: ['src/routesLatest.js', 'src/index.js'],
      acceptance_criteria: ['src/index.js dispatches API routes, scheduled weekly triggers, Workflow access, and ASSETS fallback.'],
    },
  ]);
  (plan.tasks[1] as any).source_acceptance_criteria = sourceContracts;
  (plan.tasks[2] as any).source_acceptance_criteria = sourceContracts;

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const runCriteria = byId['T08-part-2'].acceptance_criteria.join('\n');
  const latestCriteria = byId['T08-part-3'].acceptance_criteria.join('\n');

  assert.doesNotMatch(byId.T07.acceptance_criteria.join('\n'), /creates a run with a default/);
  assert.match(runCriteria, /POST \/runs creates a manual run/);
  assert.match(runCriteria, /GET \/runs\/:id returns run status/);
  assert.doesNotMatch(runCriteria, /GET \/latest returns/);
  assert.match(latestCriteria, /GET \/latest returns/);
  assert.doesNotMatch(latestCriteria, /POST \/runs creates/);
  assert.doesNotMatch(latestCriteria, /dispatches API routes/);
});

test('task plan normalization defaults endpoint contracts for sliced route ownership', () => {
  const plan = taskPlan([
    {
      id: 'T08-part-2',
      depends_on: [],
      owned_surfaces: ['src/routesRuns.js'],
    },
    {
      id: 'T08-part-3',
      depends_on: ['T08-part-2'],
      owned_surfaces: ['src/routesLatest.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const runCriteria = byId['T08-part-2'].acceptance_criteria.join('\n');
  const latestCriteria = byId['T08-part-3'].acceptance_criteria.join('\n');

  assert.match(runCriteria, /POST \/runs creates a queued manual run record/);
  assert.match(runCriteria, /GET \/runs\/:id returns run status/);
  assert.doesNotMatch(runCriteria, /GET \/latest returns/);
  assert.match(latestCriteria, /GET \/latest returns the latest completed transcript/);
  assert.doesNotMatch(latestCriteria, /POST \/runs creates/);
});

test('task plan normalization keeps session and route integration before generated index slices', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/domain.js', 'src/http.js'],
    },
    {
      id: 'T06',
      depends_on: ['T02'],
      owned_surfaces: ['src/auth.js', 'src/routes.js'],
    },
    {
      id: 'T06-part-2',
      depends_on: ['T06'],
      owned_surfaces: ['src/index.js'],
    },
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/profileHandlers.js'],
    },
    {
      id: 'T08',
      depends_on: ['T06'],
      owned_surfaces: ['src/runHandlers.js', 'src/transcriptHandlers.js'],
    },
    {
      id: 'T14',
      owner: 'designer',
      depends_on: ['T07', 'T08'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));

  assert.ok(byId['E20-auth-session']);
  assert.ok(byId['E98-route-integration']);
  assert.ok(!byId['E20-auth-session'].depends_on.includes('T06'));
  assert.ok(!byId['E20-auth-session'].depends_on.includes('T06-part-2'));
  assert.ok(byId['E98-route-integration'].depends_on.includes('T06'));
  assert.ok(!byId['E98-route-integration'].depends_on.includes('T06-part-2'));
});

test('task plan normalization attaches final entrypoint contracts only to workflow index slices', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/domain.js', 'src/http.js'],
    },
    {
      id: 'T06',
      depends_on: ['T02'],
      owned_surfaces: ['src/auth.js', 'src/routes.js'],
    },
    {
      id: 'T06-part-2',
      depends_on: ['T06'],
      owned_surfaces: ['src/index.js'],
      acceptance_criteria: [
        'src/index.js is the final Worker module entrypoint after router, scheduler, and workflow modules exist.',
        'src/index.js delegates scheduled handling to src/scheduler.js so scheduled triggers create queued run records and start WEEKLY_WORKFLOW without duplicating workflow execution logic.',
      ],
    },
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/profileHandlers.js'],
    },
    {
      id: 'T08',
      depends_on: ['T06'],
      owned_surfaces: ['src/runHandlers.js'],
    },
    {
      id: 'T13',
      depends_on: ['T08'],
      owned_surfaces: ['src/workflows/weeklyWorkflow.js', 'src/scheduler.js'],
    },
    {
      id: 'T13-part-2',
      depends_on: ['T13'],
      owned_surfaces: ['src/index.js'],
    },
    {
      id: 'T14',
      owner: 'designer',
      depends_on: ['T07', 'T08'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const earlyIndexCriteria = byId['T06-part-2'].acceptance_criteria.join('\n');
  const finalIndexCriteria = byId['T13-part-2'].acceptance_criteria.join('\n');

  assert.doesNotMatch(earlyIndexCriteria, /final Worker module entrypoint/);
  assert.doesNotMatch(earlyIndexCriteria, /delegates scheduled handling to src\/scheduler\.js/);
  assert.ok(!byId['T06-part-2'].depends_on.includes('E98-route-integration'));
  assert.ok(!byId['T06-part-2'].depends_on.includes('T13'));
  assert.match(finalIndexCriteria, /final Worker module entrypoint/);
  assert.match(finalIndexCriteria, /exports the real WeeklyWorkflow implementation/);
  assert.ok(byId['T13-part-2'].depends_on.includes('E98-route-integration'));
  assert.ok(byId['T13-part-2'].depends_on.includes('T13'));
});

test('task plan normalization infers contracts for generic routes and http auth boundaries', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
    },
    {
      id: 'T03',
      depends_on: ['T01'],
      owned_surfaces: ['src/domain.js', 'src/http.js'],
      acceptance_criteria: [
        'src/http.js centralizes JSON responses, route parameter parsing, and admin token authorization checks.',
      ],
    },
    {
      id: 'T03-part-2',
      depends_on: ['T03'],
      owned_surfaces: ['src/utils.js', 'src/logger.js'],
    },
    {
      id: 'T11',
      depends_on: ['T03-part-2'],
      owned_surfaces: ['src/routes.js', 'src/index.js'],
      acceptance_criteria: [
        'Profile upload endpoints accept multipart/form-data with kind, file, and optional setActive fields.',
        'Manual/profile/regeneration endpoints are protected by the admin token guard; public exposure of raw profile files and raw fetched content is not implemented.',
      ],
    },
    {
      id: 'T12',
      owner: 'designer',
      depends_on: ['T11'],
      owned_surfaces: ['public/index.html', 'public/app.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const routeCriteria = byId.T11.acceptance_criteria.join('\n');
  const integrationCriteria = byId['E98-route-integration'].acceptance_criteria.join('\n');

  assert.deepEqual(byId['E20-auth-session'].depends_on, ['T01', 'T03-part-2']);
  assert.deepEqual(byId['E98-route-integration'].depends_on, ['T03-part-2', 'E20-auth-session', 'T11']);
  assert.match(routeCriteria, /POST \/profiles accepts multipart\/form-data/);
  assert.match(routeCriteria, /POST \/runs creates a queued manual run record/);
  assert.match(routeCriteria, /GET \/runs\/:id returns run status/);
  assert.match(routeCriteria, /GET \/latest returns the latest completed transcript/);
  assert.match(routeCriteria, /POST \/runs\/:id\/regenerate creates a new transcript version/);
  assert.doesNotMatch(routeCriteria, /Candidate routes for a run/);
  assert.match(integrationCriteria, /browser session, profile, run, latest, regenerate, health, static asset fallback/);
  assert.doesNotMatch(integrationCriteria, /candidate/);
  assert.match(byId.T12.acceptance_criteria.join('\n'), /browser-safe auth\/session flow/);
});

test('task plan normalization canonicalizes no-bookmark status and workflow export contracts', () => {
  const plan = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['package.json', 'wrangler.jsonc', 'src/index.js'],
      acceptance_criteria: [
        'src/index.js exports a minimal WorkflowEntrypoint class whose class name matches wrangler.jsonc workflows.class_name when the Worker config defines a Workflow binding, so Wrangler dry-run validation succeeds before later workflow code delegates to src/weeklyWorkflow.js.',
      ],
    },
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/contracts.js', 'src/validation.js'],
      acceptance_criteria: ['src/contracts.js defines canonical run statuses including queued, running, completed, failed, and completed_no_bookmarks.'],
    },
    {
      id: 'T10',
      depends_on: ['T02'],
      owned_surfaces: ['src/weeklyWorkflow.js', 'src/index.js'],
      acceptance_criteria: [
        'src/weeklyWorkflow.js exports the WeeklyWorkflow class referenced by wrangler.jsonc.',
        'src/index.js preserves a stable WeeklyWorkflow export whose class name matches wrangler.jsonc workflows.class_name; later workflow code may delegate to src/weeklyWorkflow.js without changing the configured export.',
        'An empty bookmark list marks the run completed/no_content without transcript generation.',
      ],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const criteria = (id: string) => byId[id].acceptance_criteria.join('\n');

  assert.doesNotMatch(criteria('T01'), /minimal WorkflowEntrypoint class/);
  assert.match(criteria('T01'), /class named WeeklyWorkflow/);
  assert.doesNotMatch(criteria('T02'), /completed_no_bookmarks/);
  assert.match(criteria('T02'), /completed_empty/);
  assert.doesNotMatch(criteria('T10'), /later workflow code may delegate to src\/weeklyWorkflow\.js/);
  assert.doesNotMatch(criteria('T10'), /referenced by wrangler\.jsonc/);
  assert.doesNotMatch(criteria('T10'), /completed\/no_content/);
  assert.match(criteria('T10'), /fill in or delegate implementation details/);
  assert.match(criteria('T10'), /completed_empty terminal run/);
});

test('task plan normalization removes empty-run lifecycle drift outside workflow-named files', () => {
  const plan = taskPlan([
    {
      id: 'T06',
      depends_on: ['T05'],
      owned_surfaces: ['src/prompts.js', 'src/pipeline.js'],
      acceptance_criteria: [
        'src/pipeline.js treats an empty bookmark list as a completed run with no transcript.',
        'An empty bookmark list completes the run without a transcript rather than failing.',
      ],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const criteria = normalized.tasks[0].acceptance_criteria.join('\n');

  assert.doesNotMatch(criteria, /completed run with no transcript/);
  assert.doesNotMatch(criteria, /completes the run without a transcript/);
});

test('task plan normalization injects profile summary ownership before profile and workflow consumers', () => {
  const plan = taskPlan([
    {
      id: 'T05',
      depends_on: ['T03'],
      owned_surfaces: ['src/profileRepository.js'],
    },
    {
      id: 'T08',
      depends_on: ['T05'],
      owned_surfaces: ['src/aiClient.js', 'src/prompts.js'],
    },
    {
      id: 'T08-part-2',
      depends_on: ['T08'],
      owned_surfaces: ['src/aiJson.js'],
    },
    {
      id: 'T10',
      depends_on: ['T08-part-2'],
      owned_surfaces: ['src/workflow.js'],
    },
    {
      id: 'T11',
      depends_on: ['T05'],
      owned_surfaces: ['src/profileHandlers.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));
  const indexOf = (id: string) => normalized.tasks.findIndex((task) => task.id === id);

  assert.ok(byId['E21-profile-summary']);
  assert.deepEqual(byId['E21-profile-summary'].owned_surfaces, ['src/profileSummaryService.js']);
  assert.ok(indexOf('E21-profile-summary') < indexOf('T10'));
  assert.ok(indexOf('E21-profile-summary') < indexOf('T11'));
  assert.ok(byId.T10.depends_on.includes('E21-profile-summary'));
  assert.ok(byId.T11.depends_on.includes('E21-profile-summary'));
});

test('task plan normalization moves AI output validation contracts to explicit validation surfaces', () => {
  const plan = taskPlan([
    {
      id: 'T02',
      depends_on: ['T01'],
      owned_surfaces: ['src/contracts.js', 'src/validation.js'],
      acceptance_criteria: [
        'AI output validation treats model JSON as untrusted input: scores are bounded integers, required rationales and transcript fields are non-empty, sourceUrls are preserved from selected sources, primarySegment is supplied, and word counts are computed by code before persistence.',
      ],
    },
    {
      id: 'T06',
      depends_on: ['T02'],
      owned_surfaces: ['src/aiClient.js', 'src/prompts.js'],
      acceptance_criteria: [
        'AI output validation treats model JSON as untrusted input: scores are bounded integers, required rationales and transcript fields are non-empty, sourceUrls are preserved from selected sources, primarySegment is supplied, and word counts are computed by code before persistence.',
      ],
    },
    {
      id: 'T06-part-2',
      depends_on: ['T06'],
      owned_surfaces: ['src/jsonOutput.js'],
    },
    {
      id: 'T09',
      depends_on: ['T06-part-2'],
      owned_surfaces: ['src/candidateService.js', 'src/scoringService.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const byId = Object.fromEntries(normalized.tasks.map((task) => [task.id, task]));

  assert.doesNotMatch(byId.T02.acceptance_criteria.join('\n'), /AI output validation treats model JSON/);
  assert.doesNotMatch(byId.T06.acceptance_criteria.join('\n'), /AI output validation treats model JSON/);
  assert.match(byId['T06-part-2'].acceptance_criteria.join('\n'), /AI output validation treats model JSON/);
  assert.doesNotMatch(byId.T09.acceptance_criteria.join('\n'), /AI output validation treats model JSON/);
});

test('task plan normalization does not duplicate an existing route integration contract', () => {
  const plan = taskPlan([
    {
      id: 'T06',
      depends_on: [],
      owned_surfaces: ['src/router.js', 'src/auth.js'],
    },
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/routes/profiles.js'],
    },
    {
      id: 'E98-route-integration',
      depends_on: ['T07'],
      owned_surfaces: ['src/router.js'],
      acceptance_criteria: ['Every declared API endpoint is reachable through the router after this task completes.'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const integrationTasks = normalized.tasks.filter((task) => task.id.startsWith('E98-route-integration'));

  assert.deepEqual(integrationTasks.map((task) => task.id), ['E98-route-integration']);
});

test('task plan normalization collapses duplicate route integration tasks and rewrites consumers', () => {
  const plan = taskPlan([
    {
      id: 'T06',
      depends_on: [],
      owned_surfaces: ['src/router.js', 'src/auth.js'],
    },
    {
      id: 'T07',
      depends_on: ['T06'],
      owned_surfaces: ['src/routes/profiles.js'],
    },
    {
      id: 'E98-route-integration',
      depends_on: ['T07'],
      owned_surfaces: ['src/router.js'],
      acceptance_criteria: ['Every declared API endpoint is reachable through the router after this task completes.'],
    },
    {
      id: 'E98-route-integration-2',
      depends_on: ['E98-route-integration', 'T07'],
      owned_surfaces: ['src/router.js'],
      acceptance_criteria: ['src/router.js makes profile and run routes reachable through the Worker fetch path.'],
    },
    {
      id: 'T13',
      depends_on: ['E98-route-integration-2'],
      owned_surfaces: ['public/app.js'],
    },
  ]);

  const normalized = normalizeTaskPlanCloudflareWorkerContracts(plan);
  const integrationTasks = normalized.tasks.filter((task) => task.id.startsWith('E98-route-integration'));
  const consumer = normalized.tasks.find((task) => task.id === 'T13');

  assert.deepEqual(integrationTasks.map((task) => task.id), ['E98-route-integration']);
  assert.deepEqual(integrationTasks[0].depends_on, ['T06', 'E20-auth-session', 'T07']);
  assert.deepEqual(consumer?.depends_on, ['E98-route-integration', 'E20-auth-session']);
  assert.match(integrationTasks[0].acceptance_criteria.join('\n'), /browser session, profile, health, static asset fallback routes reachable/);
  assert.doesNotMatch(integrationTasks[0].acceptance_criteria.join('\n'), /profile and run routes reachable/);
});

test('task plan normalization appends operator documentation task', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.jsonc'],
    },
  ]);

  assert.deepEqual(operatorDocumentationHygiene(plan), {
    passed: false,
    reason:
      'Task plan does not include README.md operator documentation. Add an engineer-owned README.md task that captures local Wrangler validation, required Cloudflare resources/bindings, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.',
  });

  const normalized = normalizeTaskPlanOperatorDocumentation(plan);
  const documentationTask = normalized.tasks.at(-1);

  assert.ok(documentationTask);
  assert.equal(documentationTask.id, 'E99-operator-documentation');
  assert.equal(documentationTask.owner, 'engineer');
  assert.deepEqual(documentationTask.depends_on, ['T1', 'T2']);
  assert.deepEqual(documentationTask.owned_surfaces, ['README.md']);
  assert.match(documentationTask.acceptance_criteria.join('\n'), /Wrangler CLI/);
  assert.match(documentationTask.acceptance_criteria.join('\n'), /human approval/);
  assert.deepEqual(operatorDocumentationHygiene(normalized), { passed: true, reason: 'ok' });
});

test('task plan normalization rewires external dependencies to final generated slices', () => {
  const plan = taskPlan([
    {
      id: 'T05-persistence-repositories',
      depends_on: ['T04-d1-schema'],
      owned_surfaces: ['src/db.ts', 'src/artifactStore.ts'],
    },
    {
      id: 'T05-persistence-repositories-part-2',
      depends_on: ['T05-persistence-repositories'],
      owned_surfaces: ['src/profileRepository.ts', 'src/runRepository.ts'],
    },
    {
      id: 'T05-persistence-repositories-part-3',
      depends_on: ['T05-persistence-repositories-part-2'],
      owned_surfaces: ['src/bookmarkRepository.ts', 'src/linkRepository.ts'],
    },
    {
      id: 'T06-profile-service',
      depends_on: ['T05-persistence-repositories'],
      owned_surfaces: ['src/profileService.ts'],
    },
    {
      id: 'T07-run-service',
      depends_on: ['T05-persistence-repositories-part-2'],
      owned_surfaces: ['src/runService.ts'],
    },
  ]);

  assert.deepEqual(generatedSliceDependencyHygiene(plan), {
    passed: false,
    reason:
      'T06-profile-service depends_on T05-persistence-repositories, but T05-persistence-repositories is an intermediate generated slice. Depend on T05-persistence-repositories-part-3 so downstream work waits for the complete slice family before consuming it.',
  });

  const normalized = normalizeTaskPlanGeneratedSliceDependencies(plan);

  assert.deepEqual(normalized.tasks[1].depends_on, ['T05-persistence-repositories']);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T05-persistence-repositories-part-2']);
  assert.deepEqual(normalized.tasks[3].depends_on, ['T05-persistence-repositories-part-3']);
  assert.deepEqual(normalized.tasks[4].depends_on, ['T05-persistence-repositories-part-3']);
  assert.deepEqual(generatedSliceDependencyHygiene(normalized), { passed: true, reason: 'ok' });
});

test('task plan normalization splits oversized repository implementation tasks', () => {
  const plan = taskPlan([
    {
      depends_on: ['T0'],
      owned_surfaces: [
        'src/storage/d1.ts',
        'src/storage/r2.ts',
        'src/repositories/profileArtifacts.ts',
        'src/repositories/runs.ts',
        'src/repositories/bookmarks.ts',
        'src/repositories/links.ts',
        'src/repositories/candidates.ts',
        'src/repositories/candidateScores.ts',
        'src/repositories/transcripts.ts',
      ],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['src/services/profileService.ts'],
    },
  ]);

  const normalized = normalizeTaskPlanLargeStorageTasks(plan);

  assert.deepEqual(
    normalized.tasks.map((task) => task.id),
    ['T1', 'T1-part-2', 'T1-part-3', 'T1-part-4', 'T1-part-5', 'T2'],
  );
  assert.deepEqual(normalized.tasks[0].depends_on, ['T0']);
  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['src/storage/d1.ts', 'src/storage/r2.ts']);
  assert.deepEqual(normalized.tasks[1].depends_on, ['T1']);
  assert.deepEqual(normalized.tasks[1].owned_surfaces, [
    'src/repositories/profileArtifacts.ts',
    'src/repositories/runs.ts',
  ]);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T1-part-2']);
  assert.deepEqual(normalized.tasks[2].owned_surfaces, ['src/repositories/bookmarks.ts', 'src/repositories/links.ts']);
  assert.deepEqual(normalized.tasks[3].depends_on, ['T1-part-3']);
  assert.deepEqual(normalized.tasks[3].owned_surfaces, [
    'src/repositories/candidates.ts',
    'src/repositories/candidateScores.ts',
  ]);
  assert.deepEqual(normalized.tasks[4].depends_on, ['T1-part-4']);
  assert.deepEqual(normalized.tasks[4].owned_surfaces, ['src/repositories/transcripts.ts']);
  assert.deepEqual(normalized.tasks[5].depends_on, ['T1-part-5']);
});

test('task plan normalization leaves scaffold and entrypoint tasks intact', () => {
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts', 'src/env.ts', 'src/http/router.ts'],
    },
  ]);

  const normalized = normalizeTaskPlanLargeStorageTasks(plan);

  assert.deepEqual(normalized.tasks.map((task) => task.id), ['T1']);
  assert.deepEqual(normalized.tasks[0].owned_surfaces, [
    'package.json',
    'tsconfig.json',
    'src/index.ts',
    'src/env.ts',
    'src/http/router.ts',
  ]);
});

test('existing package scaffold satisfies Worker runtime plan hygiene', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-existing-scaffold-'));
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }, null, 2));
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml', 'src/env.ts', 'src/index.ts'],
    },
  ]);

  assert.deepEqual(projectScaffoldHygiene(repoPath, plan), { passed: true, reason: 'ok' });
});

test('judge provider overloads synthesize bounded failing judge output', () => {
  const error = Object.assign(new Error('The service may be temporarily overloaded, please try again later'), {
    name: 'AI_APICallError',
    statusCode: 429,
    isRetryable: true,
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    data: {
      error: {
        code: '1305',
      },
    },
  });

  const details = judgeProviderErrorDetails(error);
  assert.ok(details);
  assert.equal(details.statusCode, 429);
  assert.equal(details.code, '1305');
  assert.equal(details.retryable, true);

  const rubric = loadDeliveryEngineRubric('task-plan');
  const judgeOutput = judgeUnavailableOutputForRubric({
    rubric,
    details,
    stage: 'judge:task-plan',
  });
  assert.equal(judgeOutput.gates.every((gate) => gate.passed === false), true);
  assert.equal(judgeOutput.dimensions.length, rubric.dimensions?.length ?? 0);
  assert.equal(judgeOutput.dimensions.every((dimension) => dimension.score === null), true);

  const remediation = judgeUnavailableRemediation('judge:task-plan', details);
  const judgment = aggregateJudgment({
    rubric,
    judgeOutput: {
      gates: judgeOutput.gates.map((gate) => ({ ...gate, evidence: remediation })),
      dimensions: judgeOutput.dimensions.map((dimension) => ({ ...dimension, evidence: remediation })),
    },
  });
  judgment.remediation = [remediation, ...judgment.remediation];

  assert.equal(judgment.passed, false);
  assert.match(judgment.remediation.join('\n'), /JUDGE_UNAVAILABLE judge:task-plan/);
  assert.match(judgment.remediation.join('\n'), /no target-code change is implied/);
});

test('implementation notes list acceptance criteria that workflow verification did not run', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-verification-gaps-'));
  writeFileSync(join(repoPath, 'src-existing.ts'), 'export {};\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src-existing.ts', 'src-missing.ts'],
      acceptance_criteria: [
        'TypeScript typecheck passes.',
        'wrangler dev starts the Worker locally without errors.',
        'Worker entry point returns HTTP 200 on GET /health.',
      ],
    },
  ]).tasks;

  const verification = verificationWithAcceptanceGaps({
    repoPath,
    task,
    verification: {
      performed: ['npm run typecheck passed'],
      missing: [],
    },
  });

  assert.deepEqual(verification.performed, ['npm run typecheck passed']);
  assert.deepEqual(verification.missing, [
    'Owned surface missing after implementation: src-missing.ts',
    'Acceptance criterion not verified by automated checks: wrangler dev starts the Worker locally without errors.',
    'Acceptance criterion not verified by automated checks: Worker entry point returns HTTP 200 on GET /health.',
  ]);
});

test('acceptance contracts use task-boundary file evidence', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-acceptance-contract-evidence-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/routes/latest.js'),
    [
      'export async function routeLatest(request, env) {',
      '  return Response.json({ title: "Title", hook: "Hook", transcript: "Body", captions: [], sourceUrls: [], primarySegment: "founder", whyThisWasPicked: "score" });',
      '}',
      '',
    ].join('\n'),
  );
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/routes/latest.js'],
      acceptance_criteria: [
        'GET /latest returns the latest completed transcript fields: title, hook, transcript, captions, sourceUrls, primarySegment, and whyThisWasPicked.',
      ],
    },
  ]).tasks;

  const contracts = acceptanceContractsForTask({
    repoPath,
    task,
    verification: { performed: ['./node_modules/.bin/wrangler deploy --dry-run --env production passed'], missing: [] },
  });

  assert.equal(contracts[0].status, 'verified');
  assert.match(contracts[0].evidence.join('\n'), /file evidence covered/);
});

test('acceptance contracts verify Worker scaffold and ADMIN_TOKEN readiness structurally', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-scaffold-contracts-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.dev.vars*', '.env*', 'dist/', 'build/', '*.log', '*.cpuprofile', ''].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    [
      '{',
      '  "name": "talking-head-builder",',
      '  "main": "src/index.js",',
      '  // ADMIN_TOKEN is intentionally not present in vars.',
      '  // Configure with wrangler secret put ADMIN_TOKEN --env staging and --env production.',
      '  "env": {',
      '    "staging": { "vars": { "APP_ENV": "staging" } },',
      '    "production": { "vars": { "APP_ENV": "production" } }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'src/index.js'),
    [
      'export default {',
      '  async fetch(request) {',
      '    const url = new URL(request.url);',
      '    if (url.pathname.startsWith("/api/")) {',
      '      return Response.json({',
      '        error: "api_not_ready",',
      '        message: "Protected API endpoints are intentionally unavailable until src/auth.js exists.",',
      '        adminTokenState: "ADMIN_TOKEN must be configured as a Cloudflare secret.",',
      '        failClosedRequirement: "auth.js must fail closed when ADMIN_TOKEN is missing."',
      '      }, { status: 501 });',
      '    }',
      '    return Response.json({ status: "ok" });',
      '  }',
      '};',
      '',
    ].join('\n'),
  );
  const [task] = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['.gitignore', 'wrangler.jsonc', 'src/index.js'],
      acceptance_criteria: [
        '.gitignore excludes dependencies, Wrangler local state, env files, and build/runtime artifacts.',
        'wrangler.jsonc does not commit or embed an ADMIN_TOKEN value; ADMIN_TOKEN is treated as a required Cloudflare secret for staging and production.',
        'The scaffold leaves protected endpoints unavailable until src/auth.js exists, and later auth must fail closed when ADMIN_TOKEN is missing.',
      ],
    },
  ]).tasks;

  const contracts = acceptanceContractsForTask({ repoPath, task, verification: { performed: [], missing: [] } });

  assert.deepEqual(
    contracts.map((contract) => contract.status),
    ['verified', 'verified', 'verified'],
  );
  assert.match(contracts.map((contract) => contract.evidence.join('\n')).join('\n'), /ADMIN_TOKEN is documented as a secret/);
  assert.match(contracts.map((contract) => contract.evidence.join('\n')).join('\n'), /protected APIs stay unavailable/);
});

test('acceptance contracts verify vanilla Worker scaffold static assets and workflow export structurally', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-t01-contracts-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'talking-head-builder',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        assets: { directory: './public', binding: 'ASSETS' },
        env: {
          staging: {
            assets: { directory: './public', binding: 'ASSETS' },
            ai: { binding: 'AI' },
          },
          production: {
            assets: { directory: './public', binding: 'ASSETS' },
            ai: { binding: 'AI' },
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '.secrets*', 'secrets/', '*.pem', '*.key', '*.cpuprofile', ''].join(
      '\n',
    ),
  );
  writeFileSync(
    join(repoPath, 'src/index.js'),
    [
      'import { WorkflowEntrypoint } from "cloudflare:workers";',
      'export class WeeklyWorkflow extends WorkflowEntrypoint {',
      '  async run(event, step) { return step.do("placeholder", async () => ({ ok: true })); }',
      '}',
      'const worker = { async fetch() { return new Response("ok"); } };',
      'export default worker;',
      '',
    ].join('\n'),
  );

  const [task] = taskPlan([
    {
      id: 'T01',
      depends_on: [],
      owned_surfaces: ['wrangler.jsonc', '.gitignore', 'src/index.js'],
      acceptance_criteria: [
        'wrangler.jsonc configures Workers Static Assets with assets.directory "./public" and binding "ASSETS".',
        '.gitignore excludes node_modules, Wrangler local state, environment files, and generated secrets.',
        'No tsconfig.json is created.',
        'src/index.js exports a minimal class named WeeklyWorkflow that extends WorkflowEntrypoint when wrangler.jsonc defines workflows.class_name "WeeklyWorkflow", so Wrangler dry-run validation succeeds before later workflow code fills in the implementation without changing the configured export name.',
      ],
    },
  ]).tasks;

  const contracts = acceptanceContractsForTask({ repoPath, task, verification: { performed: [], missing: [] } });

  assert.deepEqual(
    contracts.map((contract) => contract.status),
    ['verified', 'verified', 'verified', 'verified'],
  );
  assert.match(contracts.map((contract) => contract.evidence.join('\n')).join('\n'), /Workers Static Assets/);
  assert.match(contracts.map((contract) => contract.evidence.join('\n')).join('\n'), /tsconfig\.json is absent/);
  assert.match(contracts.map((contract) => contract.evidence.join('\n')).join('\n'), /WeeklyWorkflow export/);
});

test('acceptance contract gate rejects partial workflow implementations', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-contract-gap-'));
  mkdirSync(join(repoPath, 'src/workflows'), { recursive: true });
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/workflows/weeklyWorkflow.js'),
    [
      'export class WeeklyWorkflow {',
      '  constructor(ctx, env) { this.env = env; }',
      '  async run(event, step) {',
      '    await this.env.DB.prepare("update runs set status = ? where id = ?").bind("running", event.payload.runId).run();',
      '    return { status: "running", runId: event.payload.runId };',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'src/scheduled.js'),
    'export async function scheduled(controller, env) { return env.WEEKLY_WORKFLOW.create({ params: {} }); }\n',
  );
  const [task] = taskPlan([
    {
      id: 'T11',
      depends_on: [],
      owned_surfaces: ['src/workflows/weeklyWorkflow.js', 'src/scheduled.js'],
      acceptance_criteria: [
        'WeeklyWorkflow creates or receives a run and executes discrete steps for loading profiles, fetching bookmarks, normalizing links, fetching content, extracting text, creating candidate briefs, scoring candidates, generating transcript, and storing result.',
      ],
    },
  ]).tasks;
  const verification = { performed: ['./node_modules/.bin/wrangler deploy --dry-run --env production passed'], missing: [] };
  const contracts = acceptanceContractsForTask({ repoPath, task, verification });
  const note = {
    artifact_type: 'implementation-note' as const,
    task: 'T11',
    changes: ['Implemented T11 partially.'],
    files_touched: ['src/workflows/weeklyWorkflow.js', 'src/scheduled.js'],
    acceptance_contracts: contracts,
    assumptions: [],
    verification,
    risks: [],
  };

  const results = implementationDeterministicResults({
    repoPath,
    stage: 'build:T11',
    role: 'engineer',
    task,
    note,
    events: [
      { type: 'stage_start', stage: 'build:T11', role: 'engineer' },
      {
        type: 'tool_use',
        stage: 'build:T11',
        role: 'engineer',
        tool: 'mastra_workspace_write_file',
        ok: true,
        paths: ['src/workflows/weeklyWorkflow.js', 'src/scheduled.js'],
      },
      { type: 'run_code', stage: 'build:T11', command: './node_modules/.bin/wrangler deploy --dry-run --env production', ok: true },
      { type: 'stage_end', stage: 'build:T11', reason: 'complete_stage' },
    ],
    verification,
  });

  const acceptanceGate = results.find((result) => result.id === 'acceptance_contracts_satisfied');
  assert.equal(acceptanceGate?.passed, false);
  assert.match(acceptanceGate?.reason ?? '', /WeeklyWorkflow creates or receives a run/);
  assert.match(implementationDeterministicRemediation(results).join('\n'), /acceptance_contracts_satisfied/);
});

test('implementation touched files prefer successful write events over context surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-files-touched-'));
  mkdirSync(join(repoPath, 'src'));
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default {};\n');
  writeFileSync(join(repoPath, 'src/env.ts'), 'export interface Env {}\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/env.ts'] }]).tasks;

  assert.deepEqual(
    implementationFilesTouched({
      repoPath,
      stage: 'build:T1',
      task,
      events: [
        { type: 'stage_start', stage: 'build:T1' },
        { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_read_file', ok: true, paths: ['src/index.ts'] },
        { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_write_file', ok: true, paths: ['src/env.ts'] },
        { type: 'stage_end', stage: 'build:T1' },
      ],
    }),
    ['src/env.ts'],
  );
});

test('implementation touched files accumulate successful writes across retries', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-files-touched-retries-'));
  mkdirSync(join(repoPath, 'migrations'));
  mkdirSync(join(repoPath, 'src/storage'), { recursive: true });
  writeFileSync(join(repoPath, 'migrations/0001_schema.sql'), '-- schema\n');
  writeFileSync(join(repoPath, 'src/storage/db.ts'), 'export {};\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql', 'src/storage/db.ts'],
    },
  ]).tasks;

  assert.deepEqual(
    implementationFilesTouched({
      repoPath,
      stage: 'build:T1',
      task,
      events: [
        { type: 'stage_start', stage: 'build:T1' },
        { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_write_file', ok: true, paths: ['migrations/0001_schema.sql'] },
        { type: 'stage_end', stage: 'build:T1' },
        { type: 'stage_start', stage: 'build:T1' },
        { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_write_file', ok: true, paths: ['src/storage/db.ts'] },
        { type: 'stage_end', stage: 'build:T1' },
      ],
    }),
    ['migrations/0001_schema.sql', 'src/storage/db.ts'],
  );
});

test('implementation touched files infer stage windows for workspace events without stage fields', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-files-touched-stage-window-'));
  mkdirSync(join(repoPath, 'src/storage'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default {};\n');
  writeFileSync(join(repoPath, 'src/storage/db.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'src/observability.ts'), 'export {};\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/storage/db.ts', 'src/observability.ts'],
    },
  ]).tasks;

  assert.deepEqual(
    implementationFilesTouched({
      repoPath,
      stage: 'build:T4',
      task,
      events: [
        { type: 'stage_start', stage: 'build:T1' },
        { type: 'tool_use', tool: 'mastra_workspace_write_file', ok: true, paths: ['src/index.ts'] },
        { type: 'stage_end', stage: 'build:T1' },
        { type: 'stage_start', stage: 'build:T4' },
        { type: 'tool_use', tool: 'mastra_workspace_read_file', ok: true, paths: ['src/index.ts'] },
        { type: 'tool_use', tool: 'mastra_workspace_write_file', ok: true, paths: ['src/storage/db.ts'] },
        { type: 'stage_end', stage: 'build:T4' },
        { type: 'stage_start', stage: 'build:T4' },
        { type: 'tool_use', tool: 'mastra_workspace_write_file', ok: true, paths: ['src/observability.ts'] },
        { type: 'stage_end', stage: 'build:T4' },
      ],
    }),
    ['src/storage/db.ts', 'src/observability.ts'],
  );
});

test('owned surface presence normalizes annotated paths and ignores globs', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-owned-surfaces-'));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo"\n');
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.toml (triggers section)', 'src/**', 'src/ai/client.ts'],
    },
  ]).tasks;

  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), ['src/ai/client.ts']);
});

test('conceptual owned surfaces do not become missing file paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-conceptual-surfaces-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler configuration', 'Worker Env types', 'Workflow binding registration'],
    },
  ]).tasks;

  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), []);
  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'wrangler configuration',
    'Worker Env types',
    'Workflow binding registration',
  ]);
});

test('missing owned surface preflight creates compile-safe stubs', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-preflight-stubs-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/routes/runs.ts', 'src/storage/runs.ts'],
    },
  ]).tasks;

  const created = await createMissingOwnedSurfaceStubs({ repoPath, task, stage: 'build:T1' });

  assert.deepEqual(created, ['src/routes/runs.ts', 'src/storage/runs.ts']);
  assert.equal(existsSync(join(repoPath, 'src/routes/runs.ts')), true);
  assert.match(readFileSync(join(repoPath, 'src/routes/runs.ts'), 'utf8'), /export \{\};/);
  assert.deepEqual(missingOwnedSurfacePaths(repoPath, task), []);
});

test('missing Worker entrypoint preflight creates runnable module stubs', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-preflight-worker-entry-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['workers/app.js', 'src/index.ts'],
    },
  ]).tasks;

  const created = await createMissingOwnedSurfaceStubs({ repoPath, task, stage: 'build:T1' });

  assert.deepEqual(created, ['workers/app.js', 'src/index.ts']);
  assert.match(readFileSync(join(repoPath, 'workers/app.js'), 'utf8'), /export default \{/);
  assert.match(readFileSync(join(repoPath, 'workers/app.js'), 'utf8'), /Response\.json/);
  assert.match(readFileSync(join(repoPath, 'src/index.ts'), 'utf8'), /export default \{/);
  assert.deepEqual(unreplacedPreflightStubPaths(repoPath, task), ['workers/app.js', 'src/index.ts']);
});

test('preflight stub detector fails until generated stubs are replaced', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-preflight-stub-detector-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.ts'] }]).tasks;

  await createMissingOwnedSurfaceStubs({ repoPath, task, stage: 'build:T1' });

  assert.deepEqual(unreplacedPreflightStubPaths(repoPath, task), ['src/routes/runs.ts']);

  writeFileSync(join(repoPath, 'src/routes/runs.ts'), 'export function routes() { return true; }\n');

  assert.deepEqual(unreplacedPreflightStubPaths(repoPath, task), []);
});

test('invalid tester structured output becomes a fail-closed release gate', () => {
  const gate = releaseGateForInvalidTesterOutput(
    new Error('tester release gate returned invalid structured output: response.object was undefined'),
  );

  assert.equal(gate.artifact_type, 'release-gate');
  assert.equal(gate.decision, 'fail');
  assert.equal(gate.event_type, 'pre_deployment');
  assert.equal(gate.tiers.some((tier) => tier.status === 'failed'), true);
  assert.equal(gate.critical_areas.every((area) => area.status === 'missing'), true);
  assert.match(gate.blockers.join('\n'), /invalid structured output/);
});

test('local deployment report reuses release-gate evidence without production deploy', () => {
  const report = localDeploymentReportFromReleaseGateEvidence({
    runId: 'run-local-1',
    releaseGate: {
      artifact_type: 'release-gate',
      decision: 'pass',
      event_type: 'pre_deployment',
      tiers: [
        { tier: 'smoke', status: 'passed', run_ref: 'npm run typecheck' },
        { tier: 'api', status: 'passed', run_ref: 'wrangler dev probes' },
        { tier: 'e2e', status: 'not_required', reason: 'No browser harness.' },
        { tier: 'full_matrix', status: 'not_required', reason: 'No production deploy requested.' },
      ],
      critical_areas: [
        { area: 'auth', status: 'not_applicable', reason: 'No auth surface.' },
        { area: 'billing', status: 'not_applicable', reason: 'No billing surface.' },
        { area: 'state_integrity', status: 'verified', evidence: 'D1 migration applied locally.' },
        { area: 'data_safety', status: 'verified', evidence: 'Local probes passed.' },
        { area: 'deployment_correctness', status: 'verified', evidence: 'wrangler dev probes passed.' },
        { area: 'error_responses', status: 'verified', evidence: 'Invalid JSON probe returned 400.' },
      ],
      blockers: [],
      cosmetic_issues: [],
      summary: 'Local release gate passed.',
    },
    releaseGatePath: '.delivery/artifacts/release-gate.json',
    evidencePath: '.delivery/artifacts/test-evidence.a1.json',
    evidence: {
      artifact_type: 'test-evidence',
      stage: 'test:a1',
      notes: [],
      commands: [
        {
          tier: 'smoke',
          command: 'npm run typecheck',
          ok: true,
          required: true,
          reason: 'Project verification script "typecheck" was available.',
          output_summary: 'typecheck passed',
        },
        {
          tier: 'api',
          command: 'npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/state',
          ok: true,
          required: true,
          reason: 'Local D1 migration validation was available.',
          output_summary: 'migrations applied',
        },
        {
          tier: 'api',
          command: 'npx wrangler dev --ip 127.0.0.1 --port 8787 --persist-to /tmp/state',
          ok: true,
          required: true,
          reason: 'A Wrangler Worker config was present, so local runtime verification is required before deployment.',
          output_summary: 'wrangler dev served all runtime probes.',
          probes: [
            {
              method: 'GET',
              path: '/health',
              url: 'http://127.0.0.1:8787/health',
              expected: 'GET /health returns HTTP 200 JSON with status "ok".',
              ok: true,
              status: 200,
              response_summary: 'HTTP 200; body {"status":"ok"}',
            },
          ],
        },
      ],
    },
  });

  assert.equal(report.environment, 'local');
  assert.equal(report.result, 'success');
  assert.equal(report.next_action, 'proceed');
  assert.deepEqual(report.migrations_applied, ['npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/state']);
  assert.equal(report.config_changes.some((change) => /GitHub Actions not used/.test(change)), true);
  assert.equal(report.config_changes.some((change) => /Production deployment not executed/.test(change)), true);
  assert.equal(report.verification.some((row) => row.check === 'npm run typecheck' && row.passed), true);
  assert.equal(report.verification.some((row) => row.check === 'GET /health' && row.passed), true);
  assert.match(report.rollback.steps, /No production rollback/);
  assert.deepEqual(deploymentReportSuccessNextSteps(report, '/tmp/demo-worker'), [
    'Local Wrangler validation passed. Review the deployment report and run npm run delivery:run -- --repo /tmp/demo-worker --deploy production when ready to request human approval before Wrangler production deploy.',
  ]);
});

test('local deployment report blocks next action when required local evidence failed', () => {
  const report = localDeploymentReportFromReleaseGateEvidence({
    runId: 'run-local-fail',
    releaseGate: {
      artifact_type: 'release-gate',
      decision: 'pass',
      event_type: 'pre_deployment',
      tiers: [
        { tier: 'smoke', status: 'passed', run_ref: 'npm run typecheck' },
        { tier: 'api', status: 'failed', reason: 'D1 migration failed.' },
        { tier: 'e2e', status: 'not_required', reason: 'No browser harness.' },
        { tier: 'full_matrix', status: 'not_required', reason: 'No production deploy requested.' },
      ],
      critical_areas: [
        { area: 'auth', status: 'not_applicable', reason: 'No auth surface.' },
        { area: 'billing', status: 'not_applicable', reason: 'No billing surface.' },
        { area: 'state_integrity', status: 'missing', reason: 'D1 migration failed.' },
        { area: 'data_safety', status: 'not_applicable', reason: 'No private data surface.' },
        { area: 'deployment_correctness', status: 'missing', reason: 'Local validation failed.' },
        { area: 'error_responses', status: 'not_applicable', reason: 'No API routes.' },
      ],
      blockers: [],
      cosmetic_issues: [],
      summary: 'Incorrect pass with failed local evidence.',
    },
    releaseGatePath: '.delivery/artifacts/release-gate.json',
    evidence: {
      artifact_type: 'test-evidence',
      stage: 'test:a1',
      notes: [],
      commands: [
        {
          tier: 'api',
          command: 'npx wrangler d1 migrations apply demo-db --local',
          ok: false,
          required: true,
          reason: 'Local D1 migration validation is required.',
          error: 'migration failed',
        },
      ],
    },
  });

  assert.equal(report.result, 'failure');
  assert.equal(report.next_action, 'fix');
  assert.equal(report.issues.length, 1);
  assert.match(report.issues[0].action, /production approval/);
});

test('production deploy command uses Wrangler directly without GitHub Actions', () => {
  const scriptedRepo = mkdtempSync(join(tmpdir(), 'delivery-production-scripted-deploy-'));
  writeFileSync(
    join(scriptedRepo, 'package.json'),
    JSON.stringify({ scripts: { deploy: 'wrangler deploy' } }, null, 2),
  );
  writeFileSync(join(scriptedRepo, 'wrangler.jsonc'), '{ "name": "demo-worker", "main": "src/index.ts" }\n');

  assert.deepEqual(productionWranglerDeployCommand(scriptedRepo), {
    command: 'npx wrangler deploy --env production',
    executable: 'npx',
    args: ['wrangler', 'deploy', '--env', 'production'],
  });
  assert.deepEqual(releaseGateWorkerDeployDryRunCommand(scriptedRepo), {
    command: 'npx wrangler deploy --dry-run --env production',
    executable: 'npx',
    args: ['wrangler', 'deploy', '--dry-run', '--env', 'production'],
  });

  const productionEnvRepo = mkdtempSync(join(tmpdir(), 'delivery-production-env-deploy-'));
  writeFileSync(
    join(productionEnvRepo, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.ts' }), null, 2),
  );

  assert.deepEqual(productionWranglerDeployCommand(productionEnvRepo), {
    command: 'npx wrangler deploy --env production',
    executable: 'npx',
    args: ['wrangler', 'deploy', '--env', 'production'],
  });
  assert.deepEqual(releaseGateWorkerDeployDryRunCommand(productionEnvRepo), {
    command: 'npx wrangler deploy --dry-run --env production',
    executable: 'npx',
    args: ['wrangler', 'deploy', '--dry-run', '--env', 'production'],
  });
  assert.deepEqual(releaseGateWorkerStartupCheckCommand(productionEnvRepo), {
    command: 'npx wrangler check startup --args="--env production"',
    executable: 'npx',
    args: ['wrangler', 'check', 'startup', '--args=--env production'],
  });

  const directRepo = mkdtempSync(join(tmpdir(), 'delivery-production-direct-deploy-'));
  mkdirSync(join(directRepo, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(directRepo, 'node_modules/.bin/wrangler'), '#!/usr/bin/env node\n');

  const command = productionWranglerDeployCommand(directRepo);
  assert.equal(command.command, './node_modules/.bin/wrangler deploy --env production');
  assert.equal(command.args.join(' '), 'deploy --env production');
});

test('production deployment report records native Wrangler deploy evidence', () => {
  const releaseGate = {
    artifact_type: 'release-gate' as const,
    decision: 'pass' as const,
    event_type: 'pre_deployment' as const,
    tiers: [
      { tier: 'smoke' as const, status: 'passed' as const, run_ref: 'npm run typecheck' },
      { tier: 'api' as const, status: 'passed' as const, run_ref: 'wrangler dev probes' },
      { tier: 'e2e' as const, status: 'not_required' as const, reason: 'No browser harness.' },
      { tier: 'full_matrix' as const, status: 'not_required' as const, reason: 'No production matrix.' },
    ],
    critical_areas: [
      { area: 'auth' as const, status: 'not_applicable' as const, reason: 'No auth surface.' },
      { area: 'billing' as const, status: 'not_applicable' as const, reason: 'No billing surface.' },
      { area: 'state_integrity' as const, status: 'verified' as const, evidence: 'Local D1 migration passed.' },
      { area: 'data_safety' as const, status: 'verified' as const, evidence: 'Local probes passed.' },
      { area: 'deployment_correctness' as const, status: 'verified' as const, evidence: 'Wrangler local probe passed.' },
      { area: 'error_responses' as const, status: 'verified' as const, evidence: 'Invalid JSON probe returned 400.' },
    ],
    blockers: [],
    cosmetic_issues: [],
    summary: 'Ready for production.',
  };

  const report = productionDeploymentReportFromWranglerResult({
    runId: 'run-prod-1',
    releaseGate,
    releaseGatePath: '.delivery/artifacts/release-gate.json',
    evidencePath: '.delivery/artifacts/test-evidence.a1.json',
    deployCommand: './node_modules/.bin/wrangler deploy',
    deployOk: true,
    deployOutput: 'Published demo-worker https://demo-worker.example.workers.dev Version ID: abcdefgh',
    liveVerification: {
      check: 'GET https://demo-worker.example.workers.dev',
      expected: 'Production Worker responds with an HTTP status below 500.',
      actual: 'HTTP 200',
      passed: true,
    },
    revision: 'wrangler:abcdefgh',
  });

  assert.equal(report.environment, 'production');
  assert.equal(report.result, 'success');
  assert.equal(report.next_action, 'monitor');
  assert.deepEqual(deploymentReportSuccessNextSteps(report, '/tmp/demo-worker'), ['monitor']);
  assert.equal(report.revision, 'wrangler:abcdefgh');
  assert.equal(report.config_changes.some((change) => /GitHub Actions not used/.test(change)), true);
  assert.equal(report.verification.some((row) => row.check === './node_modules/.bin/wrangler deploy' && row.passed), true);

  const failed = productionDeploymentReportFromWranglerResult({
    runId: 'run-prod-fail',
    releaseGate,
    releaseGatePath: '.delivery/artifacts/release-gate.json',
    deployCommand: './node_modules/.bin/wrangler deploy',
    deployOk: false,
    deployError: 'authentication failed',
    liveVerification: {
      check: 'production live verification',
      expected: 'Production live verification runs after deploy.',
      actual: 'Skipped because deploy failed.',
      passed: false,
    },
  });

  assert.equal(failed.result, 'failure');
  assert.equal(failed.next_action, 'fix');
  assert.match(failed.issues.map((issue) => issue.action).join('\n'), /request production approval again/);
});

test('release gate evidence planner uses bounded local commands', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
  );
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', '[[d1_databases]]', 'binding = "DB"', 'database_name = "demo-db"'].join('\n'),
  );

  assert.equal(releaseGateLocalD1DatabaseName(repoPath), 'demo-db');
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath).map((command) => ({
      tier: command.tier,
      command: command.command,
      required: command.required,
    })),
	    [
	      { tier: 'smoke', command: 'npm run typecheck', required: true },
	      { tier: 'api', command: 'npx wrangler deploy --dry-run --env production', required: true },
	      { tier: 'api', command: 'npx wrangler check startup --args="--env production"', required: true },
	      { tier: 'api', command: 'npx wrangler d1 migrations apply demo-db --env staging --local', required: true },
	    ],
	  );
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command),
	    [
	      'npm run typecheck',
	      'npx wrangler deploy --dry-run --env production',
	      'npx wrangler check startup --args="--env production"',
	      'npx wrangler d1 migrations apply demo-db --env staging --local --persist-to /tmp/probe-state',
	    ],
	  );
});

test('release gate evidence planner runs the available package verification matrix', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-matrix-'));
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'node --test',
          build: 'wrangler deploy --dry-run',
        },
      },
      null,
      2,
    ),
  );

  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath).map((command) => ({
      tier: command.tier,
      command: command.command,
      required: command.required,
    })),
    [
      { tier: 'smoke', command: 'npm run typecheck', required: true },
      { tier: 'smoke', command: 'npm run test', required: true },
      { tier: 'smoke', command: 'npm run build', required: true },
    ],
  );
});

test('build verification falls back to Wrangler dry run for vanilla JS Workers', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-build-verification-worker-dry-run-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.js' }), null, 2),
  );

  assert.deepEqual(buildVerificationCommandPlan(repoPath), {
    command: 'npx wrangler deploy --dry-run --env production',
    executable: 'npx',
    args: ['wrangler', 'deploy', '--dry-run', '--env', 'production'],
    timeoutMs: 180_000,
  });

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          check: 'node --check src/index.js',
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );

  assert.deepEqual(buildVerificationCommandPlan(repoPath), {
    command: 'npm run check',
    executable: 'npm',
    args: ['run', 'check'],
    timeoutMs: 120_000,
  });
});

test('release gate evidence planner checks generated Wrangler types for TypeScript Workers', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-types-check-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'npm run generate-types && tsc --noEmit' } }, null, 2),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(releaseGateWorkerTypesCheckCommand(repoPath), {
    command: 'npx wrangler types --check',
    executable: 'npx',
    args: ['wrangler', 'types', '--check'],
  });
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath).map((command) => ({
      tier: command.tier,
      command: command.command,
      required: command.required,
    })),
    [
      { tier: 'smoke', command: 'npx wrangler types --check', required: true },
      { tier: 'smoke', command: 'npm run typecheck', required: true },
      { tier: 'api', command: 'npx wrangler deploy --dry-run --env production', required: true },
      { tier: 'api', command: 'npx wrangler check startup --args="--env production"', required: true },
    ],
  );
});

test('release gate evidence planner uses wrangler.jsonc D1 config for required local migrations', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-jsonc-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'migrations/0001_schema.sql'), 'CREATE TABLE runs (id TEXT PRIMARY KEY);\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    [
      '{',
      '  "$schema": "./node_modules/wrangler/config-schema.json",',
      '  "name": "talking-head-builder",',
      '  "main": "src/index.ts",',
      '  "d1_databases": [',
      '    { "binding": "DB", "database_name": "talking-head-builder", "database_id": "local-placeholder" },',
      '  ],',
      '}',
      '',
    ].join('\n'),
  );

  assert.equal(releaseGateLocalD1DatabaseName(repoPath), 'talking-head-builder');
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => ({
      tier: command.tier,
      command: command.command,
      required: command.required,
    })),
	    [
	      { tier: 'smoke', command: 'npm run typecheck', required: true },
	      { tier: 'api', command: 'npx wrangler deploy --dry-run --env production', required: true },
	      { tier: 'api', command: 'npx wrangler check startup --args="--env production"', required: true },
	      {
	        tier: 'api',
	        command: 'npx wrangler d1 migrations apply talking-head-builder --env staging --local --persist-to /tmp/probe-state',
        required: true,
      },
    ],
  );
});

test('release gate D1 migration validation targets staging environments', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-jsonc-staging-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { typecheck: 'node --check src/index.js' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'migrations/0001_schema.sql'), 'CREATE TABLE runs (id TEXT PRIMARY KEY);\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'talking-head-builder',
        main: 'src/index.js',
        d1_databases: [{ binding: 'DB', database_name: 'talking-head-builder', database_id: 'local-placeholder' }],
        env: {
          staging: {
            d1_databases: [{ binding: 'DB', database_name: 'talking-head-builder-staging', database_id: 'staging-id' }],
          },
          production: {
            d1_databases: [{ binding: 'DB', database_name: 'talking-head-builder-production', database_id: 'production-id' }],
          },
        },
      },
      null,
      2,
    ),
  );

  assert.equal(releaseGateLocalD1DatabaseName(repoPath), 'talking-head-builder-staging');
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command),
    [
      'npm run typecheck',
      'npx wrangler deploy --dry-run --env production',
      'npx wrangler check startup --args="--env production"',
      'npx wrangler d1 migrations apply talking-head-builder-staging --env staging --local --persist-to /tmp/probe-state',
    ],
  );
});

test('release gate D1 migration validation targets TOML staging environments', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-evidence-toml-staging-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(join(repoPath, 'migrations/0001_schema.sql'), 'CREATE TABLE runs (id TEXT PRIMARY KEY);\n');
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    [
      'name = "demo-worker"',
      'main = "src/index.js"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db"',
      '[env.staging]',
      'name = "demo-worker-staging"',
      '[[env.staging.d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db-staging"',
      '[env.production]',
      'name = "demo-worker-production"',
      '[[env.production.d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db-production"',
      '',
    ].join('\n'),
  );

  assert.equal(releaseGateLocalD1DatabaseName(repoPath), 'demo-db-staging');
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command),
    [
      'npx wrangler deploy --dry-run --env production',
      'npx wrangler check startup --args="--env production"',
      'npx wrangler d1 migrations apply demo-db-staging --env staging --local --persist-to /tmp/probe-state',
    ],
  );
});

test('release gate Wrangler commands prefer the installed local binary', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-local-wrangler-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  mkdirSync(join(repoPath, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(repoPath, 'node_modules/.bin/wrangler'), '#!/usr/bin/env node\n');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(join(repoPath, 'migrations/0001_schema.sql'), 'CREATE TABLE runs (id TEXT PRIMARY KEY);\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        name: 'demo-worker',
        main: 'src/index.ts',
        d1_databases: [{ binding: 'DB', database_name: 'demo-db' }],
      },
      null,
      2,
    ),
  );

  assert.equal(
    releaseGateEvidenceCommandPlan(repoPath)[0].command,
    './node_modules/.bin/wrangler types --check',
  );
  assert.equal(
    releaseGateEvidenceCommandPlan(repoPath)[1].command,
    './node_modules/.bin/wrangler deploy --dry-run --env production',
  );
  assert.equal(
    releaseGateEvidenceCommandPlan(repoPath)[2].command,
    './node_modules/.bin/wrangler check startup --args="--env production"',
  );
  assert.equal(
    releaseGateEvidenceCommandPlan(repoPath)[3].command,
    './node_modules/.bin/wrangler d1 migrations apply demo-db --env staging --local',
  );
  assert.equal(releaseGateWorkerTypesCheckCommand(repoPath)?.command, './node_modules/.bin/wrangler types --check');
  assert.equal(releaseGateWorkerDeployDryRunCommand(repoPath)?.command, './node_modules/.bin/wrangler deploy --dry-run --env production');
  assert.equal(releaseGateWorkerStartupCheckCommand(repoPath)?.command, './node_modules/.bin/wrangler check startup --args="--env production"');
  assert.equal(releaseGateWorkerDevCommand(repoPath, 8787)?.command, './node_modules/.bin/wrangler dev --env staging --ip 127.0.0.1 --port 8787');

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        name: 'demo-worker',
        main: 'src/index.ts',
        d1_databases: [{ binding: 'DB', database_name: 'demo-db' }],
      }),
      null,
      2,
    ),
  );

  assert.equal(
    releaseGateWorkerDevCommand(repoPath, 8787)?.command,
    './node_modules/.bin/wrangler dev --env staging --ip 127.0.0.1 --port 8787',
  );
});

test('release gate local admin secret path targets staging Wrangler environment files', () => {
  const baseRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-secret-base-'));
  writeFileSync(
    join(baseRepoPath, 'wrangler.jsonc'),
    JSON.stringify({ name: 'demo-worker', main: 'src/index.ts' }, null, 2),
  );
  assert.equal(releaseGateLocalAdminSecretPath(baseRepoPath), join(baseRepoPath, '.dev.vars.staging'));

  const stagingRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-secret-staging-'));
  writeFileSync(
    join(stagingRepoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.ts' }), null, 2),
  );
  assert.equal(releaseGateLocalAdminSecretPath(stagingRepoPath), join(stagingRepoPath, '.dev.vars.staging'));

  const genericDevVarsRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-secret-generic-dev-vars-'));
  writeFileSync(
    join(genericDevVarsRepoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.ts' }), null, 2),
  );
  writeFileSync(join(genericDevVarsRepoPath, '.dev.vars'), 'API_HOST="localhost:3000"\n');
  assert.equal(releaseGateLocalAdminSecretPath(genericDevVarsRepoPath), join(genericDevVarsRepoPath, '.dev.vars'));

  const stagingDevVarsRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-secret-staging-dev-vars-'));
  writeFileSync(
    join(stagingDevVarsRepoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.ts' }), null, 2),
  );
  writeFileSync(join(stagingDevVarsRepoPath, '.dev.vars'), 'API_HOST="localhost:3000"\n');
  writeFileSync(join(stagingDevVarsRepoPath, '.dev.vars.staging'), 'API_HOST="staging.localhost:3000"\n');
  assert.equal(
    releaseGateLocalAdminSecretPath(stagingDevVarsRepoPath),
    join(stagingDevVarsRepoPath, '.dev.vars.staging'),
  );

  const stagingEnvRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-secret-staging-env-'));
  writeFileSync(
    join(stagingEnvRepoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.ts' }), null, 2),
  );
  writeFileSync(join(stagingEnvRepoPath, '.env.staging'), 'API_HOST="staging.localhost:3000"\n');
  assert.equal(releaseGateLocalAdminSecretPath(stagingEnvRepoPath), join(stagingEnvRepoPath, '.env.staging'));
});

test('release gate admin secrets are required only for authenticated runtime probes', () => {
  const publicRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-public-probes-'));
  mkdirSync(join(publicRepoPath, 'workers'), { recursive: true });
  writeFileSync(join(publicRepoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(publicRepoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "workers/app.js"\n');
  writeFileSync(
    join(publicRepoPath, 'workers/app.js'),
    [
      "if (url.pathname === '/api/health') {}",
      "if (url.pathname === '/api/links') {}",
      "if (url.pathname.startsWith('/api/links/')) {}",
      "if (url.pathname.startsWith('/l/')) {}",
    ].join('\n'),
  );

  assert.equal(releaseGateRuntimeProbePlanRequiresAdminSecret(releaseGateRuntimeProbePlan(publicRepoPath)), false);

  const adminRepoPath = mkdtempSync(join(tmpdir(), 'delivery-release-admin-probes-'));
  writeTalkingHeadSourceDocs(adminRepoPath);
  mkdirSync(join(adminRepoPath, 'src'), { recursive: true });
  writeFileSync(join(adminRepoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(adminRepoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(join(adminRepoPath, 'src/index.ts'), "if (pathname === '/profiles') {}\n");

  assert.equal(releaseGateRuntimeProbePlanRequiresAdminSecret(releaseGateRuntimeProbePlan(adminRepoPath)), true);
});

test('release gate deterministic checks fail closed on failed required local evidence', () => {
  assert.deepEqual(
    releaseGateRequiredEvidencePassed({
      artifact_type: 'test-evidence',
      stage: 'test:a1',
      notes: [],
      commands: [
        {
          tier: 'smoke',
          command: 'npm run typecheck',
          ok: true,
          required: true,
          reason: 'Project typecheck is required.',
        },
        {
          tier: 'api',
          command: 'npx wrangler d1 migrations apply demo-db --local',
          ok: false,
          required: true,
          reason: 'Local D1 migration validation is required.',
          error: 'migration failed',
        },
        {
          tier: 'api',
          command: 'optional diagnostic',
          ok: false,
          required: false,
          reason: 'Optional diagnostic.',
          error: 'optional failure',
        },
      ],
    }),
    {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: 'required release-gate evidence failed: npx wrangler d1 migrations apply demo-db --local: migration failed',
    },
  );

  assert.equal(
    releaseGateRequiredEvidencePassed({
      artifact_type: 'test-evidence',
      stage: 'test:a1',
      notes: [],
      commands: [
        {
          tier: 'api',
          command: 'npx wrangler dev --ip 127.0.0.1 --port 8787',
          ok: true,
          required: true,
          reason: 'Local runtime probes are required.',
        },
      ],
    }).passed,
    true,
  );
});

test('release gate runtime probe planner uses Wrangler CLI directly', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(join(repoPath, 'src/routes/health.ts'), 'export const path = "/health";\n');

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999), {
    command: 'npx wrangler dev --env staging --ip 127.0.0.1 --port 8999',
    executable: 'npx',
    args: ['wrangler', 'dev', '--env', 'staging', '--ip', '127.0.0.1', '--port', '8999'],
  });
  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999, '/tmp/state'), {
    command: 'npx wrangler dev --env staging --ip 127.0.0.1 --port 8999 --persist-to /tmp/state',
    executable: 'npx',
    args: ['wrangler', 'dev', '--env', 'staging', '--ip', '127.0.0.1', '--port', '8999', '--persist-to', '/tmp/state'],
  });

  const plan = releaseGateRuntimeProbePlan(repoPath);
  assert.equal(plan?.required, true);
  assert.equal(plan?.command.command, 'npx wrangler dev --env staging --ip 127.0.0.1 --port <port>');
  assert.deepEqual(
    plan?.probes.map((probe) => ({ path: probe.path, expectedStatus: probe.expectedStatus, statusBelow: probe.statusBelow })),
    [
      { path: '/', expectedStatus: undefined, statusBelow: 500 },
      { path: '/health', expectedStatus: 200, statusBelow: undefined },
    ],
  );
});

test('release gate runtime probe planner discovers Worker API health routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-api-health-'));
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "workers/app.js"\n');
  writeFileSync(
    join(repoPath, 'workers/app.js'),
    [
      "if (url.pathname === '/api/health') {",
      '  return new Response(JSON.stringify({ ok: true }));',
      '}',
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath)?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    ['GET /', 'GET /api/health'],
  );
  assert.deepEqual(probes.find((probe) => probe.path === '/api/health')?.jsonContainsAny, [
    { status: 'ok' },
    { ok: true },
  ]);
});

test('release gate runtime probe planner exercises short-link lifecycle routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-link-lifecycle-'));
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\nBuild a Cloudflare Worker URL shortener for short links.\n');
  writeFileSync(
    join(repoPath, 'spec.md'),
    '# Spec\nPOST /api/links creates a short link. GET /l/:id redirects and increments clicks.\n',
  );
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "workers/app.js"\n');
  writeFileSync(
    join(repoPath, 'workers/app.js'),
    [
      "if (url.pathname === '/api/health') {}",
      "if (url.pathname === '/api/links') {}",
      "if (url.pathname.startsWith('/api/links/')) {}",
      "if (url.pathname.startsWith('/l/')) {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath)?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    [
      'GET /',
      'GET /api/health',
      'POST /api/links',
      'POST /api/links',
      'POST /api/links',
      'GET /api/links',
      'POST /api/links',
      'GET /api/links/{{releaseGateLinkId}}',
      'GET /l/{{releaseGateLinkId}}',
      'GET /api/links/{{releaseGateLinkId}}',
      'GET /api/links/unknown-release-gate',
      'GET /l/unknown-release-gate',
    ],
  );

  const createProbe = probes.find((probe) => probe.captures?.releaseGateLinkId === 'id');
  assert.equal(createProbe?.expectedStatus, 201);
  assert.deepEqual(createProbe?.jsonFieldMatches, { id: '^[A-Za-z0-9_-]{6}$' });

  const redirectProbe = probes.find((probe) => probe.path === '/l/{{releaseGateLinkId}}');
  assert.equal(redirectProbe?.redirect, 'manual');
  assert.deepEqual(redirectProbe?.headersContain, { location: 'https://example.com/mastra-release-gate' });

  const incrementProbe = probes.find(
    (probe) => probe.path === '/api/links/{{releaseGateLinkId}}' && probe.jsonContains?.clicks === 1,
  );
  assert.deepEqual(incrementProbe?.jsonFieldsEqualVariables, { id: 'releaseGateLinkId' });
});

test('release gate runtime probe planner does not infer short-link lifecycle from routes alone', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-link-routes-only-'));
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "workers/app.js"\n');
  writeFileSync(
    join(repoPath, 'workers/app.js'),
    [
      "if (url.pathname === '/api/health') {}",
      "if (url.pathname === '/api/links') {}",
      "if (url.pathname.startsWith('/api/links/')) {}",
      "if (url.pathname.startsWith('/l/')) {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath)?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    ['GET /', 'GET /api/health'],
  );
});

test('release gate runtime probe targets staging when the Worker config defines it', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-staging-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments({ name: 'demo-worker', main: 'src/index.js' }), null, 2),
  );

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999, '/tmp/state'), {
    command: 'npx wrangler dev --env staging --ip 127.0.0.1 --port 8999 --persist-to /tmp/state',
    executable: 'npx',
    args: ['wrangler', 'dev', '--env', 'staging', '--ip', '127.0.0.1', '--port', '8999', '--persist-to', '/tmp/state'],
  });

  assert.equal(releaseGateRuntimeProbePlan(repoPath)?.command.command, 'npx wrangler dev --env staging --ip 127.0.0.1 --port <port>');
});

test('release gate runtime probe planner verifies public Worker assets', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-assets-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'public'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("api") };\n');
  writeFileSync(join(repoPath, 'public/index.html'), '<!doctype html><title>Demo</title>\n');
  writeFileSync(join(repoPath, 'public/styles.css'), 'body { color: #111; }\n');
  writeFileSync(join(repoPath, 'public/app.js'), 'window.appReady = true;\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        assets: { directory: './public', binding: 'ASSETS' },
      }),
      null,
      2,
    ),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath)?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    ['GET /', 'GET /styles.css', 'GET /app.js'],
  );
  assert.equal(probes[0].expectedStatus, 200);
  assert.equal(probes[0].textContains, '<!doctype html><title>Demo</title>');
  assert.equal(probes[1].textContains, 'body { color: #111; }');
  assert.equal(probes[2].textContains, 'window.appReady = true;');
});

test('release gate runtime probe planner covers common Worker API state and error routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-probes-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      "if (pathname === '/profiles') {}",
      "if (pathname === '/runs') {}",
      "if (pathname === '/latest') {}",
      "if (pathname === '/health') {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath, 'test-admin-token')?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    [
      'GET /',
      'GET /health',
      'GET /latest',
      'POST /runs',
      'POST /runs',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'GET /profiles',
    ],
  );
  assert.equal(
    probes
      .filter((probe) => probe.path === '/runs' || probe.path === '/profiles')
      .every((probe) => probe.headers?.authorization === 'Bearer test-admin-token'),
    true,
  );
  assert.equal(probes.some((probe) => probe.body?.type === 'multipart-profile'), true);
  assert.equal(
    probes.some((probe) =>
      probe.jsonArrayAssertions?.some(
        (assertion) =>
          assertion.type === 'countObjects' &&
          assertion.count === 1 &&
          assertion.where.kind === 'audience_segments' &&
          assertion.where.isActive === true,
      ),
    ),
    true,
  );
});

test('release gate runtime probe planner source-gates Talking Head product routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-generic-runtime-probes-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      "if (pathname === '/profiles') {}",
      "if (pathname === '/runs') {}",
      "if (pathname === '/latest') {}",
      "if (pathname === '/health') {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath, 'test-admin-token')?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    ['GET /', 'GET /health'],
  );
});

test('release gate runtime probe planner discovers routes in vanilla JS Worker entries', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-js-probes-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'workers/app.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, 'workers/app.js'),
    [
      "if (url.pathname === '/profiles') {}",
      "if (url.pathname === '/runs') {}",
      "if (url.pathname === '/latest') {}",
      "if (url.pathname === '/health') {}",
    ].join('\n'),
  );

  const probes = releaseGateRuntimeProbePlan(repoPath, 'test-admin-token')?.probes ?? [];
  assert.deepEqual(
    probes.map((probe) => `${probe.method} ${probe.path}`),
    [
      'GET /',
      'GET /health',
      'GET /latest',
      'POST /runs',
      'POST /runs',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'POST /profiles',
      'GET /profiles',
    ],
  );
});

test('release gate evidence planner seeds latest transcript and version audit fixtures when schema is present', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-transcript-fixture-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2));
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    ['name = "demo-worker"', 'main = "src/index.ts"', '[[d1_databases]]', 'binding = "DB"', 'database_name = "demo-db"'].join('\n'),
  );
  writeFileSync(join(repoPath, 'src/index.ts'), "if (pathname === '/latest') {}\n");
  writeFileSync(
    join(repoPath, 'migrations/0001_init.sql'),
    [
      'CREATE TABLE runs (',
      '  id TEXT PRIMARY KEY,',
      '  status TEXT NOT NULL,',
      '  window_start TEXT NOT NULL,',
      '  window_end TEXT NOT NULL,',
      '  audience_profile_id TEXT NOT NULL,',
      '  voice_profile_id TEXT NOT NULL,',
      '  selected_candidate_id TEXT,',
      '  transcript_id TEXT,',
      '  error_message TEXT,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ');',
      'CREATE TABLE candidates (',
      '  id TEXT PRIMARY KEY,',
      '  run_id TEXT NOT NULL,',
      '  bookmark_id TEXT,',
      '  link_id TEXT,',
      '  source_url TEXT NOT NULL,',
      '  title TEXT NOT NULL,',
      '  author TEXT,',
      '  published_at TEXT,',
      '  summary TEXT NOT NULL,',
      '  core_idea TEXT NOT NULL,',
      '  suggested_angle TEXT NOT NULL,',
      '  primary_segment TEXT NOT NULL,',
      '  segment_fit_json TEXT NOT NULL,',
      '  created_at TEXT NOT NULL',
      ');',
      'CREATE TABLE transcripts (',
      '  id TEXT PRIMARY KEY,',
      '  run_id TEXT NOT NULL,',
      '  candidate_id TEXT NOT NULL,',
      '  audience_profile_id TEXT NOT NULL,',
      '  voice_profile_id TEXT NOT NULL,',
      '  title TEXT NOT NULL,',
      '  hook TEXT NOT NULL,',
      '  transcript TEXT NOT NULL,',
      '  captions_json TEXT NOT NULL,',
      '  source_urls_json TEXT NOT NULL,',
      '  why_this_was_picked TEXT NOT NULL,',
      '  primary_segment TEXT NOT NULL,',
      '  alternate_angles_json TEXT NOT NULL,',
      '  word_count INTEGER NOT NULL,',
      '  created_at TEXT NOT NULL',
      ');',
    ].join('\n'),
  );

  const commands = releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command);
  assert.deepEqual(commands, [
    'npx wrangler types --check',
    'npx wrangler deploy --dry-run --env production',
    'npx wrangler check startup --args="--env production"',
    'npx wrangler d1 migrations apply demo-db --env staging --local --persist-to /tmp/probe-state',
    'npx wrangler d1 execute demo-db --env staging --local --persist-to /tmp/probe-state --file .delivery/tmp/release-gate-transcript-fixture.sql --json',
    'npx wrangler d1 execute demo-db --env staging --local --persist-to /tmp/probe-state --command "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = \'release-gate-transcript-v1\' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = \'release-gate-transcript-v2\' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = \'release-gate-run\') AS active_transcript_id FROM transcripts WHERE run_id = \'release-gate-run\'" --json',
  ]);
  assert.match(
    readFileSync(join(repoPath, '.delivery/tmp/release-gate-transcript-fixture.sql'), 'utf8'),
    /release-gate-transcript-v2/,
  );

  const latestProbe = releaseGateRuntimeProbePlan(repoPath)?.probes.find((probe) => probe.method === 'GET' && probe.path === '/latest');
  assert.equal(latestProbe?.expectedStatus, 200);
  assert.deepEqual(latestProbe?.jsonContains, {
    title: 'Release Gate Regenerated Transcript',
    hook: 'Regenerated hook.',
    primarySegment: 'operators',
    whyThisWasPicked: 'Regenerated selection rationale.',
  });
});

test('release gate latest transcript fixture schema check catches incomplete migrations', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-transcript-schema-gaps-'));
  writeTalkingHeadSourceDocs(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), "if (pathname === '/latest') {}\n");
  writeFileSync(
    join(repoPath, 'migrations/0001_init.sql'),
    [
      'CREATE TABLE runs (id TEXT PRIMARY KEY);',
      'CREATE TABLE candidates (id TEXT PRIMARY KEY);',
      'CREATE TABLE transcripts (id TEXT PRIMARY KEY, title TEXT NOT NULL);',
    ].join('\n'),
  );

  const gaps = releaseGateTranscriptFixtureSchemaGaps(repoPath);
  assert.match(gaps.join('\n'), /runs\.status/);
  assert.match(gaps.join('\n'), /candidates\.source_url/);
  assert.match(gaps.join('\n'), /transcripts\.hook/);

  const staticResult = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Latest transcript fixture schema',
  );
  assert.equal(staticResult?.required, true);
  assert.equal(staticResult?.ok, false);
  assert.match(staticResult?.error ?? '', /seeded GET \/latest/);
});

test('release gate runtime probe planner falls back to npx wrangler for Worker configs', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-npx-'));
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host 0.0.0.0' } }, null, 2));
  writeFileSync(join(repoPath, 'wrangler.jsonc'), '{ "name": "demo-worker", "main": "src/index.ts" }\n');

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999), {
    command: 'npx wrangler dev --env staging --ip 127.0.0.1 --port 8999',
    executable: 'npx',
    args: ['wrangler', 'dev', '--env', 'staging', '--ip', '127.0.0.1', '--port', '8999'],
  });
});

test('Workers AI projects require an active Wrangler AI binding and required Env field', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workers-ai-binding-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      'import { createAiClient } from "./ai/client";',
      'export interface Env { AI?: Ai }',
      'export const load = (env: Env) => createAiClient(env);',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    [
      'name = "demo-worker"',
      `compatibility_date = "${currentCompatibilityDate()}"`,
      'compatibility_flags = [ "nodejs_compat" ]',
      '',
      '[observability]',
      'enabled = true',
      'head_sampling_rate = 1',
      '',
      '# [ai]',
      '# binding = "AI"',
    ].join('\n'),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml', 'src/index.ts'] }]).tasks;
  const workersAiEvidence = () =>
    releaseGateStaticEvidenceResults(repoPath).find((result) => result.command === 'static check: Workers AI binding configured');

  assert.equal(wranglerConfigHasWorkersAiBinding(repoPath), false);
  assert.deepEqual(workersAiBindingGaps(repoPath, task), [
    'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML).',
    'Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.',
  ]);
  assert.deepEqual(
    workersAiEvidence() && {
      command: workersAiEvidence()?.command,
      ok: workersAiEvidence()?.ok,
      required: workersAiEvidence()?.required,
      error: workersAiEvidence()?.error,
    },
    {
      command: 'static check: Workers AI binding configured',
      ok: false,
      required: true,
      error:
        'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML). Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.',
    },
  );

  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    [
      'name = "demo-worker"',
      `compatibility_date = "${currentCompatibilityDate()}"`,
      'compatibility_flags = [ "nodejs_compat" ]',
      '',
      '[observability]',
      'enabled = true',
      'head_sampling_rate = 1',
      '',
      '[ai]',
      'binding = "AI"',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      'import { createAiClient } from "./ai/client";',
      'export interface Env { AI: Ai }',
      'export const load = (env: Env) => createAiClient(env);',
    ].join('\n'),
  );

  assert.equal(wranglerConfigHasWorkersAiBinding(repoPath), true);
  assert.deepEqual(workersAiBindingGaps(repoPath, task), []);
  assert.equal(workersAiEvidence()?.ok, true);
});

test('Workers AI binding checks support vanilla JS Worker source', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workers-ai-js-binding-'));
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(
    join(repoPath, 'workers/tally.js'),
    [
      'export default {',
      '  async fetch(request, env) {',
      '    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "score" });',
      '    return Response.json(response);',
      '  }',
      '};',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'workers/tally.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc', 'workers/tally.js'] }]).tasks;
  const workersAiEvidence = () =>
    releaseGateStaticEvidenceResults(repoPath).find((result) => result.command === 'static check: Workers AI binding configured');

  assert.deepEqual(workersAiBindingGaps(repoPath, task), [
    'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML).',
  ]);
  assert.equal(workersAiEvidence()?.ok, false);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'workers/tally.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        ai: { binding: 'AI' },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workersAiBindingGaps(repoPath, task), []);
  assert.equal(workersAiEvidence()?.ok, true);
  assert.match(workersAiEvidence()?.output_summary ?? '', /TypeScript Env declarations, when present/);
});

test('Workers AI binding checks detect destructured and bracket AI access', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workers-ai-access-patterns-'));
  mkdirSync(join(repoPath, 'workers'), { recursive: true });
  writeFileSync(
    join(repoPath, 'workers/destructure.js'),
    [
      'export default {',
      '  async fetch(request, env) {',
      '    const { AI: model } = env;',
      '    const response = await model.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "score" });',
      '    return Response.json(response);',
      '  }',
      '};',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'workers/bracket.js'),
    [
      'export async function score(env) {',
      '  const model = env["AI"];',
      '  return model.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "score" });',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'workers/destructure.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc', 'workers/destructure.js'] }]).tasks;

  assert.deepEqual(workersAiBindingGaps(repoPath, task), [
    'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML).',
  ]);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'workers/destructure.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        ai: { binding: 'AI' },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workersAiBindingGaps(repoPath, task), []);
});

test('Worker config hygiene requires current JSONC schema date flags and observability', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-hygiene-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc'] }]).tasks;

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    [
      '{',
      '  "$schema": "node_modules/wrangler/config-schema.json",',
      '  "name": "demo-worker",',
      '  "main": "src/index.ts",',
      '  "compatibility_date": "2025-01-01", // stale',
      '  "compatibility_flags": [],',
      '  "observability": { "enabled": false },',
      '}',
      '',
    ].join('\n'),
  );

  const gaps = workerConfigHygieneGaps(repoPath, task);
  assert.match(gaps.join('\n'), /\$schema/);
  assert.match(gaps.join('\n'), /compatibility_date "2025-01-01" is stale/);
  assert.match(gaps.join('\n'), /nodejs_compat/);
  assert.match(gaps.join('\n'), /observability\.enabled/);
  assert.match(gaps.join('\n'), /head_sampling_rate/);
  assert.match(gaps.join('\n'), /env\.staging is missing/);

  const remediation = [`DETERMINISTIC cloudflare_worker_config_current failed: ${gaps.join('; ')}`];
  assert.equal(implementationFailureClass(remediation), 'worker_config');
  assert.equal(
    implementationRetryMode({
      remediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: {
          enabled: true,
          head_sampling_rate: 1,
        },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
  assert.deepEqual(workerConfigHygieneGaps(repoPath), []);
  const workerConfigEvidence = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Worker config hygiene',
  );
  assert.equal(workerConfigEvidence?.tier, 'api');
  assert.equal(workerConfigEvidence?.ok, true);
});

test('Worker config hygiene requires deployment environments with mirrored bindings and vars', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-envs-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc'] }]).tasks;

  const baseConfig = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: 'demo-worker',
    main: 'src/index.ts',
    compatibility_date: currentCompatibilityDate(),
    compatibility_flags: ['nodejs_compat'],
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: { ENVIRONMENT: 'local' },
    ai: { binding: 'AI' },
    d1_databases: [{ binding: 'DB', database_name: 'demo-db', database_id: 'demo-db' }],
  };

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        ...baseConfig,
        env: {
          staging: {},
          production: { ai: { binding: 'AI' } },
        },
      },
      null,
      2,
    ),
  );

  const gaps = workerConfigHygieneGaps(repoPath, task).join('\n');
  assert.match(gaps, /env\.staging must declare AI as an ai binding/);
  assert.match(gaps, /env\.staging must declare DB as a d1 binding/);
  assert.match(gaps, /env\.staging\.vars must declare ENVIRONMENT/);
  assert.match(gaps, /env\.production must declare DB as a d1 binding/);
  assert.match(gaps, /env\.production\.vars must declare ENVIRONMENT/);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(withWorkerDeploymentEnvironments(baseConfig), null, 2),
  );

  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
});

test('acceptance contracts verify Worker env binding mirrors with structured wrangler config evidence', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-acceptance-'));
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['wrangler.jsonc'],
      acceptance_criteria: [
        'wrangler.jsonc defines env.staging and env.production and mirrors BOOKMARKS, DB, ARTIFACTS, WEEKLY_WORKFLOW, AI, assets.directory "./public", assets.binding "ASSETS", and required non-secret vars in both environments.',
      ],
    },
  ]).tasks;

  const environment = (name: 'staging' | 'production') => ({
    vars: {
      APP_ENV: name,
      DEFAULT_WINDOW_DAYS: '7',
      ADMIN_TOKEN_REQUIRED: 'true',
      ADMIN_TOKEN_SECRET_NAME: 'ADMIN_TOKEN',
    },
    assets: { directory: './public', binding: 'ASSETS' },
    services: [{ binding: 'BOOKMARKS', service: 'bookmarks', environment: name }],
    d1_databases: [{ binding: 'DB', database_name: `talking-head-builder-${name}`, database_id: `${name}-db` }],
    r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: `talking-head-builder-artifacts-${name}` }],
    workflows: [{ binding: 'WEEKLY_WORKFLOW', name: `talking-head-weekly-workflow-${name}`, class_name: 'WeeklyWorkflow' }],
    ai: { binding: 'AI' },
  });

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        name: 'talking-head-builder',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        env: {
          staging: environment('staging'),
          production: environment('production'),
        },
      },
      null,
      2,
    ),
  );

  const contracts = acceptanceContractsForTask({
    repoPath,
    task,
    verification: { performed: [], missing: [] },
  });

  assert.equal(contracts[0].status, 'verified');
  assert.match(contracts[0].evidence.join('\n'), /structured wrangler\.jsonc evidence/);

  const broken = JSON.parse(readFileSync(join(repoPath, 'wrangler.jsonc'), 'utf8')) as Record<string, any>;
  delete broken.env.production.ai;
  writeFileSync(join(repoPath, 'wrangler.jsonc'), JSON.stringify(broken, null, 2));

  const brokenContracts = acceptanceContractsForTask({
    repoPath,
    task,
    verification: { performed: [], missing: [] },
  });
  assert.equal(brokenContracts[0].status, 'unverified');
  assert.match(brokenContracts[0].gaps.join('\n'), /env\.production is missing AI as a ai binding/);
});

test('acceptance contracts verify Worker entrypoint exports structurally', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-entrypoint-acceptance-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  const [task] = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/index.js'],
      acceptance_criteria: [
        'src/index.js exports a default Worker fetch handler and a WeeklyWorkflow class stub so the project is structurally runnable before later feature code is added.',
      ],
    },
  ]).tasks;

  writeFileSync(
    join(repoPath, 'src/index.js'),
    [
      'import { WorkflowEntrypoint } from "cloudflare:workers";',
      'export class WeeklyWorkflow extends WorkflowEntrypoint { async run() { return { ok: true }; } }',
      'export default { async fetch() { return new Response("ok"); } };',
    ].join('\n'),
  );

  const contracts = acceptanceContractsForTask({
    repoPath,
    task,
    verification: { performed: [], missing: [] },
  });

  assert.equal(contracts[0].status, 'verified');
  assert.match(contracts[0].evidence.join('\n'), /structured Worker entrypoint evidence/);

  writeFileSync(join(repoPath, 'src/index.js'), 'export default { async fetch() { return new Response("ok"); } };\n');
  const brokenContracts = acceptanceContractsForTask({
    repoPath,
    task,
    verification: { performed: [], missing: [] },
  });
  assert.equal(brokenContracts[0].status, 'unverified');
  assert.match(brokenContracts[0].gaps.join('\n'), /WeeklyWorkflow class stub/);
});

test('Worker config hygiene checks TOML deployment environment mirrors', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-toml-envs-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml'] }]).tasks;

  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    [
      'name = "demo-worker"',
      'main = "src/index.ts"',
      `compatibility_date = "${currentCompatibilityDate()}"`,
      'compatibility_flags = ["nodejs_compat"]',
      '[observability]',
      'enabled = true',
      'head_sampling_rate = 1',
      '[vars]',
      'ENVIRONMENT = "local"',
      '[ai]',
      'binding = "AI"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db"',
      'database_id = "demo-db"',
      '[env.staging]',
      '[env.production.ai]',
      'binding = "AI"',
      '',
    ].join('\n'),
  );

  const gaps = workerConfigHygieneGaps(repoPath, task).join('\n');
  assert.match(gaps, /env\.staging must declare AI as an ai binding/);
  assert.match(gaps, /env\.staging must declare DB as a d1 binding/);
  assert.match(gaps, /env\.production must declare DB as a d1 binding/);
  assert.match(gaps, /env\.production\.vars must declare ENVIRONMENT/);

  writeFileSync(
    join(repoPath, 'wrangler.toml'),
    [
      'name = "demo-worker"',
      'main = "src/index.ts"',
      `compatibility_date = "${currentCompatibilityDate()}"`,
      'compatibility_flags = ["nodejs_compat"]',
      '[observability]',
      'enabled = true',
      'head_sampling_rate = 1',
      '[vars]',
      'ENVIRONMENT = "local"',
      '[ai]',
      'binding = "AI"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db"',
      'database_id = "demo-db"',
      '[env.staging.vars]',
      'ENVIRONMENT = "staging"',
      '[env.staging.ai]',
      'binding = "AI"',
      '[[env.staging.d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db-staging"',
      'database_id = "demo-db-staging"',
      '[env.production.vars]',
      'ENVIRONMENT = "production"',
      '[env.production.ai]',
      'binding = "AI"',
      '[[env.production.d1_databases]]',
      'binding = "DB"',
      'database_name = "demo-db-production"',
      'database_id = "demo-db-production"',
      '',
    ].join('\n'),
  );

  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
});

test('Worker release gate fails closed when Wrangler config is missing', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-missing-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
          'generate-types': 'wrangler types',
          typecheck: 'npm run generate-types && tsc --noEmit',
        },
        devDependencies: { '@types/node': 'latest', wrangler: '^4.0.0' },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'WebWorker'],
          types: ['./worker-configuration.d.ts', 'node'],
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile', ''].join('\n'),
  );

  const staticResult = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Worker config hygiene',
  );
  const requiredStaticFailures = releaseGateRequiredStaticEvidenceFailures(releaseGateStaticEvidenceResults(repoPath));

  assert.equal(staticResult?.ok, false);
  assert.equal(staticResult?.tier, 'api');
  assert.equal(staticResult?.required, true);
  assert.match(staticResult?.error ?? '', /No Wrangler config file exists/);
  assert.deepEqual(
    requiredStaticFailures.map((result) => result.command),
    ['static check: Worker config hygiene'],
  );
});

test('Worker release gate fails closed on package scaffold drift', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-package-release-gate-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev',
          deploy: 'wrangler deploy',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile', ''].join('\n'),
  );

  const badResult = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Worker package scaffold hygiene',
  );
  assert.equal(badResult?.required, true);
  assert.equal(badResult?.ok, false);
  assert.match(badResult?.error ?? '', /wrangler dev --env staging/);
  assert.match(badResult?.error ?? '', /wrangler deploy --env production/);
  assert.equal(releaseGateRequiredStaticEvidenceFailures([badResult!]).length, 1);

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );

  const goodResult = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Worker package scaffold hygiene',
  );
  assert.equal(goodResult?.required, true);
  assert.equal(goodResult?.ok, true);
  assert.match(goodResult?.output_summary ?? '', /Worker package scripts/);
});

test('Worker package scaffold hygiene requires wildcard local secret ignores', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-package-gitignore-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars', '.env', '*.cpuprofile', ''].join('\n'),
  );

  const gaps = workerPackageScaffoldGaps(repoPath).join('\n');
  assert.match(gaps, /\.dev\.vars\*/);
  assert.match(gaps, /\.env\*/);

  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile', ''].join('\n'),
  );
  assert.deepEqual(workerPackageScaffoldGaps(repoPath), []);
});

test('Worker package scaffold release gate catches missing package manifests', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-package-missing-release-gate-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.js',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );

  const result = releaseGateStaticEvidenceResults(repoPath).find(
    (item) => item.command === 'static check: Worker package scaffold hygiene',
  );
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /package\.json is missing/);
});

test('Worker config hygiene requires a service name and existing entrypoint', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-entrypoint-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc'] }]).tasks;

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo worker',
        main: 'src/missing.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      },
      null,
      2,
    ),
  );

  const gaps = workerConfigHygieneGaps(repoPath, task);
  assert.match(gaps.join('\n'), /name "demo worker"/);
  assert.match(gaps.join('\n'), /main "src\/missing\.ts" does not exist/);

  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo_worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
});

test('Worker config hygiene aligns Cloudflare binding names with Env declarations', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-env-align-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc'] }]).tasks;

  writeFileSync(
    join(repoPath, 'src', 'env.ts'),
    [
      'export interface Env {',
      '  DB: D1Database;',
      '  PROFILE_BUCKET: R2Bucket;',
      '  ARTIFACT_BUCKET: R2Bucket;',
      '  AI: Ai;',
      '  PROCESSING_WORKFLOW: Workflow;',
      '  BOOKMARKS: Fetcher;',
      '  ADMIN_TOKEN: string;',
      '}',
    ].join('\n'),
  );
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        services: [{ binding: 'BOOKMARKS', service: 'bookmarks' }],
        d1_databases: [{ binding: 'DB', database_name: 'demo-db', database_id: 'demo-db' }],
        r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: 'artifacts' }],
        workflows: [{ binding: 'WEEKLY_WORKFLOW', name: 'weekly', class_name: 'WeeklyWorkflow' }],
        ai: { binding: 'AI' },
      }),
      null,
      2,
    ),
  );

  const gaps = workerEnvBindingAlignmentGaps(repoPath);
  assert.match(gaps.join('\n'), /PROFILE_BUCKET.*r2 binding/);
  assert.match(gaps.join('\n'), /ARTIFACT_BUCKET.*r2 binding/);
  assert.match(gaps.join('\n'), /PROCESSING_WORKFLOW.*workflow binding/);
  assert.match(gaps.join('\n'), /ARTIFACTS.*no matching r2 Env property/);
  assert.match(gaps.join('\n'), /WEEKLY_WORKFLOW.*no matching workflow Env property/);
  assert.match(workerConfigHygieneGaps(repoPath, task).join('\n'), /PROFILE_BUCKET/);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        services: [{ binding: 'BOOKMARKS', service: 'bookmarks' }],
        d1_databases: [{ binding: 'DB', database_name: 'demo-db', database_id: 'demo-db' }],
        r2_buckets: [
          { binding: 'PROFILE_BUCKET', bucket_name: 'profiles' },
          { binding: 'ARTIFACT_BUCKET', bucket_name: 'artifacts' },
        ],
        workflows: [{ binding: 'PROCESSING_WORKFLOW', name: 'weekly', class_name: 'WeeklyWorkflow' }],
        ai: { binding: 'AI' },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workerEnvBindingAlignmentGaps(repoPath), []);
  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
});

test('Worker config hygiene requires Workers Static Assets for public UI files', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-static-assets-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'public'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  writeFileSync(join(repoPath, 'public/index.html'), '<!doctype html><div id="app"></div>\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.jsonc'] }]).tasks;

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
      }),
      null,
      2,
    ),
  );

  assert.match(workerConfigHygieneGaps(repoPath, task).join('\n'), /assets is missing/);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        assets: { directory: './dist', binding: 'ASSETS' },
      }),
      null,
      2,
    ),
  );

  assert.match(workerConfigHygieneGaps(repoPath, task).join('\n'), /assets\.directory/);

  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        assets: { directory: './public' },
      }),
      null,
      2,
    ),
  );

  assert.match(workerConfigHygieneGaps(repoPath, task).join('\n'), /assets\.binding/);

  writeFileSync(join(repoPath, 'src/env.ts'), ['export interface Env {', '  OLD_ASSETS: Fetcher;', '}'].join('\n'));
  writeFileSync(join(repoPath, 'worker-configuration.d.ts'), ['interface Env {', '  ASSETS: Fetcher;', '}'].join('\n'));
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      withWorkerDeploymentEnvironments({
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: { enabled: true, head_sampling_rate: 1 },
        assets: { directory: './public', binding: 'ASSETS' },
      }),
      null,
      2,
    ),
  );

  assert.deepEqual(workerEnvBindingAlignmentGaps(repoPath), []);
  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
});

test('Worker config task packet policy carries the exact current compatibility date', () => {
  const policy = workerConfigTaskPacketPolicy();

  assert.equal(policy.schema, './node_modules/wrangler/config-schema.json');
  assert.equal(policy.compatibility_date, currentCompatibilityDate());
  assert.deepEqual(policy.compatibility_flags, ['nodejs_compat']);
  assert.deepEqual(policy.observability, { enabled: true, head_sampling_rate: 1 });
  assert.deepEqual(policy.static_assets, {
    when_public_directory_exists: {
      directory: './public',
      binding: 'ASSETS',
    },
  });
  assert.deepEqual(policy.deployment_environments.required, ['staging', 'production']);
  assert.equal(policy.deployment_environments.staging_dev_command, 'wrangler dev --env staging');
  assert.equal(
    policy.deployment_environments.staging_d1_migration_command,
    'wrangler d1 migrations apply <database> --env staging --local',
  );
  assert.equal(policy.deployment_environments.production_dry_run_command, 'wrangler deploy --dry-run --env production');
  assert.equal(policy.deployment_environments.production_deploy_command, 'wrangler deploy --env production');
  assert.match(policy.deployment_environments.note, /non-inheritable/);
  assert.deepEqual(policy.generated_types, {
    command: 'wrangler types',
    output: 'worker-configuration.d.ts',
    tsconfig_types: ['./worker-configuration.d.ts', 'node'],
  });
});

test('task plan schema describes explicit Worker environment commands', () => {
  const schema = JSON.parse(
    readFileSync(join(process.cwd(), 'src/mastra/delivery-engine/schemas/task-plan.schema.json'), 'utf8'),
  ) as {
    properties: {
      tasks: {
        items: {
          properties: {
            owner: { description: string };
            owned_surfaces: { description: string };
          };
        };
      };
    };
  };

  const descriptions = [
    schema.properties.tasks.items.properties.owner.description,
    schema.properties.tasks.items.properties.owned_surfaces.description,
  ].join('\n');

  assert.match(descriptions, /wrangler dev --env staging/);
  assert.match(descriptions, /wrangler deploy --env production/);
  assert.match(descriptions, /env\.staging\/env\.production|env\.staging and env\.production/);
  assert.match(descriptions, /root scaffold task owns package\.json, \.gitignore, wrangler\.jsonc/);
});

test('agent and task-plan template describe root Worker config scaffold', () => {
  const agentInstructions = readFileSync(join(process.cwd(), 'src/mastra/delivery-engine/agents.ts'), 'utf8');
  const taskPlanTemplate = readFileSync(
    join(process.cwd(), 'src/mastra/delivery-engine/templates/task-plan.md'),
    'utf8',
  );

  assert.match(agentInstructions, /package\.json, \.gitignore, wrangler\.jsonc/);
  assert.match(agentInstructions, /Wrangler dry-run validation can run from the first build slice/);
  assert.match(taskPlanTemplate, /package\.json`/);
  assert.match(taskPlanTemplate, /`\.gitignore`, `wrangler\.jsonc`/);
  assert.match(taskPlanTemplate, /Wrangler dry-run\s+validation can run from the first build slice/);
});

test('Worker package scaffold hygiene requires current Wrangler tooling and config-based scripts', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-package-hygiene-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default { fetch: () => new Response("ok") };\n');
  const [jsTask] = taskPlan([{ depends_on: [], owned_surfaces: ['package.json', 'src/index.js'] }]).tasks;

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev src/index.js',
          deploy: 'wrangler deploy src/index.js',
          build: 'vite build',
        },
        dependencies: {
          react: '^19.0.0',
          vite: '^7.0.0',
        },
        devDependencies: {
          '@cloudflare/workers-types': '^4.20250124.0',
          wrangler: '^3.107.3',
        },
      },
      null,
      2,
    ),
  );

  const gaps = workerPackageScaffoldGaps(repoPath, jsTask);
  assert.match(gaps.join('\n'), /scripts\.dev/);
  assert.match(gaps.join('\n'), /scripts\.deploy/);
  assert.match(gaps.join('\n'), /wrangler.*v4\+/);
  assert.match(gaps.join('\n'), /frontend framework\/build dependencies.*react.*vite/);
  assert.match(gaps.join('\n'), /scripts\.build uses a frontend framework\/bundler/);
  assert.match(gaps.join('\n'), /\.gitignore is missing/);
  assert.doesNotMatch(gaps.join('\n'), /workers-types/);
  assert.doesNotMatch(gaps.join('\n'), /tsconfig\.json/);

  const remediation = [`DETERMINISTIC worker_package_scaffold_current failed: ${gaps.join('; ')}`];
  assert.equal(implementationFailureClass(remediation), 'worker_package');
  assert.equal(
    implementationRetryMode({
      remediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev',
          deploy: 'wrangler deploy',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, '.gitignore'),
    ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile', ''].join('\n'),
  );

  const genericEnvironmentGaps = workerPackageScaffoldGaps(repoPath, jsTask);
  assert.match(genericEnvironmentGaps.join('\n'), /wrangler dev --env staging/);
  assert.match(genericEnvironmentGaps.join('\n'), /wrangler deploy --env production/);

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
        devDependencies: {
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );

  assert.deepEqual(workerPackageScaffoldGaps(repoPath, jsTask), []);

  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');
  const [tsTask] = taskPlan([{ depends_on: [], owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts'] }]).tasks;

  const missingTypeScriptGaps = workerPackageScaffoldGaps(repoPath, tsTask);
  assert.match(missingTypeScriptGaps.join('\n'), /scripts\.generate-types/);
  assert.match(missingTypeScriptGaps.join('\n'), /scripts\.typecheck.*generate-types/);
  assert.match(missingTypeScriptGaps.join('\n'), /@types\/node.*missing/);
  assert.match(missingTypeScriptGaps.join('\n'), /tsconfig\.json: missing/);
  assert.doesNotMatch(missingTypeScriptGaps.join('\n'), /workers-types/);

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
          'generate-types': 'wrangler types',
          typecheck: 'npm run generate-types && tsc --noEmit',
        },
        devDependencies: {
          '@types/node': 'latest',
          wrangler: '^4.0.0',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(repoPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'WebWorker'],
          types: ['./worker-configuration.d.ts', 'node'],
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );

  assert.deepEqual(workerPackageScaffoldGaps(repoPath, tsTask), []);
  assert.deepEqual(workerPackageScaffoldGaps(repoPath), []);
});

test('stale downstream verification repair resets only future failed task surfaces', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stale-downstream-repair-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/steps/score-candidates.ts'), 'export const score = 1;\n');
  writeFileSync(
    join(repoPath, 'src/workflows/steps/generate-transcript.ts'),
    'export const transcript = buildUsageStats();\n',
  );
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/**', 'src/workflows/steps/score-candidates.ts'] },
    { depends_on: ['T1'], owned_surfaces: ['src/workflows/steps/generate-transcript.ts'] },
  ]);
  const failure = [
    "src/workflows/steps/score-candidates.ts(1,1): error TS2322: Type 'number' is not assignable.",
    "src/workflows/steps/generate-transcript.ts(1,27): error TS2304: Cannot find name 'buildUsageStats'.",
  ].join('\n');

  assert.deepEqual(
    staleDownstreamVerificationSurfacePaths({
      repoPath,
      taskPlan: plan,
      currentTaskIndex: 0,
      failure,
    }),
    ['src/workflows/steps/generate-transcript.ts'],
  );

  assert.equal(
    await repairStaleDownstreamVerificationSurfaces({
      repoPath,
      stage: 'build:T1',
      taskPlan: plan,
      currentTaskIndex: 0,
      failure,
    }),
    true,
  );
  assert.equal(readFileSync(join(repoPath, 'src/workflows/steps/score-candidates.ts'), 'utf8'), 'export const score = 1;\n');
  assert.match(readFileSync(join(repoPath, 'src/workflows/steps/generate-transcript.ts'), 'utf8'), /Delivery preflight stub/);
});

test('out-of-plan verification failures are classified as stale workspace contamination', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-stale-out-of-plan-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/env.ts'), 'export interface Env { AI: Ai }\n');
  writeFileSync(
    join(repoPath, 'src/workflows/steps/fetch-content.ts'),
    'import type { Env } from "../../env";\nexport const fetchContent = (env: Env) => env.BROWSER;\n',
  );
  const plan = taskPlan([{ depends_on: [], owned_surfaces: ['src/env.ts'] }]);
  const failure =
    'src/workflows/steps/fetch-content.ts(2,55): error TS2339: Property BROWSER does not exist on type Env.';

  assert.deepEqual(outOfPlanVerificationFailurePaths({ repoPath, taskPlan: plan, failure }), [
    'src/workflows/steps/fetch-content.ts',
  ]);
  assert.equal(
    implementationFailureClass([
      'DETERMINISTIC verification_passed failed: STALE_WORKSPACE_VERIFICATION: repo-wide verification failed in existing file(s) outside the current task plan: src/workflows/steps/fetch-content.ts',
    ]),
    'stale_workspace_verification',
  );
});

test('lifecycle status schema columns require D1 CHECK constraints', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-lifecycle-status-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  writeFileSync(
    join(repoPath, 'migrations/0001_schema.sql'),
    [
      'CREATE TABLE runs (',
      "  id TEXT PRIMARY KEY,",
      "  status TEXT NOT NULL DEFAULT 'pending',",
      "  fetch_status TEXT NOT NULL DEFAULT 'queued' CHECK (fetch_status IN ('queued', 'complete', 'failed'))",
      ');',
    ].join('\n'),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['migrations/0001_schema.sql'] }]).tasks;

  assert.deepEqual(lifecycleStatusSchemaGaps(repoPath, task), [
    'migrations/0001_schema.sql:status is a lifecycle status column without a D1 CHECK constraint',
  ]);

  writeFileSync(
    join(repoPath, 'migrations/0001_schema.sql'),
    [
      'CREATE TABLE runs (',
      "  id TEXT PRIMARY KEY,",
      "  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'stuck')),",
      "  fetch_status TEXT NOT NULL DEFAULT 'queued' CHECK (fetch_status IN ('queued', 'complete', 'failed'))",
      ');',
    ].join('\n'),
  );

  assert.deepEqual(lifecycleStatusSchemaGaps(repoPath, task), []);
});

test('task boundaries include existing sibling TypeScript barrel files', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/ai'), { recursive: true });
  writeFileSync(join(repoPath, 'src/ai/index.ts'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/ai/client.ts', 'src/ai/types.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), ['src/ai/client.ts', 'src/ai/types.ts', 'src/ai/index.ts']);
});

test('task boundaries include existing sibling JavaScript barrel files', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-js-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/ai'), { recursive: true });
  writeFileSync(join(repoPath, 'src/ai/index.js'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/ai/client.js', 'src/ai/types.js'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), ['src/ai/client.js', 'src/ai/types.js', 'src/ai/index.js']);
});

test('route task boundaries include the existing Worker entry integration surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-route-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default {};\n');
  writeFileSync(join(repoPath, 'src/routes/index.ts'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/profiles.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/routes/profiles.ts',
    'src/routes/index.ts',
    'src/index.ts',
  ]);
});

test('route task boundaries include JavaScript Worker entry integration surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-js-route-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.js'), 'export default {};\n');
  writeFileSync(join(repoPath, 'src/routes/index.js'), 'export {};\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/profiles.js'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/routes/profiles.js',
    'src/routes/index.js',
    'src/index.js',
  ]);
});

test('route tasks must integrate through the existing Worker router', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-route-middleware-bypass-'));
  mkdirSync(join(repoPath, 'src/http'), { recursive: true });
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(join(repoPath, 'src/http/router.ts'), 'export function routeRequest() { return new Response("ok"); }\n');
  writeFileSync(join(repoPath, 'src/routes/runs.ts'), 'export function handleRunsRequest() { return new Response("runs"); }\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      "import { routeRequest } from './http/router';",
      "import { handleRunsRequest } from './routes/runs';",
      'export default {',
      '  fetch(request: Request) {',
      "    if (new URL(request.url).pathname === '/runs') return handleRunsRequest();",
      '    return routeRequest();',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.ts'] }]).tasks;

  assert.deepEqual(routeMiddlewareBypassGaps(repoPath, task), [
    'Route surface src/routes/runs.ts is imported directly from src/index.ts while the existing routeRequest router is present; register it through the router/barrel/middleware path instead of dispatching before routeRequest.',
  ]);

  writeFileSync(
    join(repoPath, 'src/index.ts'),
    [
      "import { routeRequest } from './http/router';",
      'export default {',
      '  fetch(request: Request) {',
      '    return routeRequest();',
      '  },',
      '};',
      '',
    ].join('\n'),
  );

  assert.deepEqual(routeMiddlewareBypassGaps(repoPath, task), []);
});

test('JavaScript route tasks must integrate through the existing Worker router', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-js-route-middleware-bypass-'));
  mkdirSync(join(repoPath, 'src/http'), { recursive: true });
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(join(repoPath, 'src/http/router.js'), 'export function routeRequest() { return new Response("ok"); }\n');
  writeFileSync(join(repoPath, 'src/routes/runs.js'), 'export function handleRunsRequest() { return new Response("runs"); }\n');
  writeFileSync(
    join(repoPath, 'src/index.js'),
    [
      "import { routeRequest } from './http/router.js';",
      "import { handleRunsRequest } from './routes/runs.js';",
      'export default {',
      '  fetch(request) {',
      "    if (new URL(request.url).pathname === '/runs') return handleRunsRequest();",
      '    return routeRequest();',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.js'] }]).tasks;

  assert.deepEqual(routeMiddlewareBypassGaps(repoPath, task), [
    'Route surface src/routes/runs.js is imported directly from src/index.js while the existing routeRequest router is present; register it through the router/barrel/middleware path instead of dispatching before routeRequest.',
  ]);

  writeFileSync(
    join(repoPath, 'src/index.js'),
    [
      "import { routeRequest } from './http/router.js';",
      'export default {',
      '  fetch(request) {',
      '    return routeRequest();',
      '  },',
      '};',
      '',
    ].join('\n'),
  );

  assert.deepEqual(routeMiddlewareBypassGaps(repoPath, task), []);
});

test('workflow step task boundaries include the Workflow entrypoint integration surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/weekly.ts'), 'export class WeeklyWorkflow {}\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.ts'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/workflows/steps/fetch-bookmarks.ts',
    'src/workflows/weekly.ts',
  ]);
});

test('JavaScript workflow step task boundaries include the Workflow entrypoint integration surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-js-workflow-boundary-surfaces-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/weekly.js'), 'export class WeeklyWorkflow {}\n');
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.js'] }]).tasks;

  assert.deepEqual(taskBoundarySurfaces(repoPath, task), [
    'src/workflows/steps/fetch-bookmarks.js',
    'src/workflows/weekly.js',
  ]);
});

test('workflow step implementation must be integrated into WeeklyWorkflow before reuse', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-integration-gap-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/steps/fetch-bookmarks.ts'), 'export const fetchBookmarksStep = () => true;\n');
  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    'export class WeeklyWorkflow { async fetchBookmarks(context: unknown) { return context; } }\n',
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.ts'] }]).tasks;

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), [
    'Workflow step src/workflows/steps/fetch-bookmarks.ts is not called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    "import { fetchBookmarksStep } from './steps/fetch-bookmarks';\nexport class WeeklyWorkflow { async fetchBookmarks(context: unknown) { return context; } }\n",
  );

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), [
    'Workflow step src/workflows/steps/fetch-bookmarks.ts is not called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflows/weekly.ts'),
    "import { fetchBookmarksStep } from './steps/fetch-bookmarks';\nexport class WeeklyWorkflow { step = fetchBookmarksStep; }\n",
  );

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), []);
});

test('JavaScript workflow step implementation must be integrated into WeeklyWorkflow before reuse', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-js-workflow-integration-gap-'));
  mkdirSync(join(repoPath, 'src/workflows/steps'), { recursive: true });
  writeFileSync(join(repoPath, 'src/workflows/steps/fetch-bookmarks.js'), 'export const fetchBookmarksStep = () => true;\n');
  writeFileSync(
    join(repoPath, 'src/workflows/weekly.js'),
    'export class WeeklyWorkflow { async fetchBookmarks(context) { return context; } }\n',
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflows/steps/fetch-bookmarks.js'] }]).tasks;

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), [
    'Workflow step src/workflows/steps/fetch-bookmarks.js is not called from src/workflows/weekly.js; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflows/weekly.js'),
    "import { fetchBookmarksStep } from './steps/fetch-bookmarks.js';\nexport class WeeklyWorkflow { step = fetchBookmarksStep; }\n",
  );

  assert.deepEqual(workflowStepIntegrationGaps(repoPath, task), []);
});

test('WorkflowEntrypoint implementations import Cloudflare Workflow base class', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-workflow-entrypoint-import-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/workflow.js'),
    'export class WeeklyWorkflow extends WorkflowEntrypoint { async run() {} }\n',
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/workflow.js'] }]).tasks;

  assert.deepEqual(workflowEntrypointImportGaps(repoPath, task), [
    'src/workflow.js extends WorkflowEntrypoint but does not import WorkflowEntrypoint from cloudflare:workers.',
  ]);

  writeFileSync(
    join(repoPath, 'src/workflow.js'),
    "import { WorkflowEntrypoint } from 'cloudflare:workers';\nexport class WeeklyWorkflow extends WorkflowEntrypoint { async run() {} }\n",
  );

  assert.deepEqual(workflowEntrypointImportGaps(repoPath, task), []);
});

test('engine policy mismatch stops retries for normalized in-boundary paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-engine-policy-mismatch-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml'] }]).tasks;

  const remediation = implementationEnginePolicyMismatch({
    repoPath,
    stage: 'build:T1',
    role: 'engineer',
    task,
    events: [
      { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
      {
        type: 'tool_use',
        tool: 'mastra_workspace_edit_file',
        ok: false,
        paths: ['wrangler.toml (triggers section)'],
        error: "wrangler.toml (triggers section) is outside this task's owned surfaces [wrangler.toml]",
      },
    ],
  });

  assert.equal(remediation.length, 1);
  assert.match(remediation[0], /ENGINE_POLICY_MISMATCH T1/);
  assert.match(remediation[0], /wrangler\.toml/);
});

test('engine policy mismatch ignores genuinely out-of-boundary paths', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-engine-policy-real-block-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/routes/runs.ts'] }]).tasks;

  assert.deepEqual(
    implementationEnginePolicyMismatch({
      repoPath,
      stage: 'build:T1',
      role: 'engineer',
      task,
      events: [
        { type: 'stage_start', stage: 'build:T1', role: 'engineer' },
        {
          type: 'tool_use',
          tool: 'mastra_workspace_edit_file',
          ok: false,
          paths: ['wrangler.toml'],
          error: "wrangler.toml is outside this task's owned surfaces [src/routes/runs.ts]",
        },
      ],
    }),
    [],
  );
});

const implementationNote = {
  artifact_type: 'implementation-note' as const,
  task: 'T1',
  changes: ['Implemented T1'],
  files_touched: ['src/index.ts'],
  assumptions: [],
  verification: {
    performed: ['npm run typecheck passed'],
    missing: ['Acceptance criterion not verified by automated checks: wrangler dev starts locally.'],
  },
  risks: [],
};

const implementationJudgment = {
  rubric: 'implementation',
  overall: 0.65,
  overall_uncapped: 0.65,
  threshold: 0.7,
  passed: false,
  gates: [],
  gates_failed: [],
  dimensions_scored: [
    { id: 'smallest_coherent_change', score: 4, weight: 8, evidence: 'ok' },
    { id: 'implementation_note_quality', score: 4, weight: 5, evidence: 'honest and complete' },
  ],
  dimensions_not_scored: [],
  dimensions_missing: [],
  remediation: [],
};

test('non-actionable implementation judgment can proceed to release-gate verification', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('actionable implementation remediation still blocks the fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: {
        ...implementationJudgment,
        remediation: ['DIMENSION implementation_note_quality scored 2/5. Add missing checks.'],
      },
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
});

test('weak implementation dimensions synthesize actionable remediation', () => {
  const judgment = {
    ...implementationJudgment,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 4, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'candidate_scores does not carry run_id; selected candidate behavior is hard to audit.',
      },
    ],
  };

  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    false,
  );
  assert.deepEqual(implementationWeakDimensionRemediation(judgment), [
    'DIMENSION state_explicitness scored 3/5. Improve this before continuing: candidate_scores does not carry run_id; selected candidate behavior is hard to audit.',
  ]);
});

test('passing implementation judgments complete despite soft weak dimensions', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.82,
    passed: true,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'status columns are free text without CHECK constraints.',
      },
    ],
  };

  assert.equal(
    implementationJudgmentCanComplete({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('passing implementation judgments complete despite explicit judge remediation', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.78,
    passed: true,
    remediation: [
      'DIMENSION error_response_quality scored 2/5. Add richer next steps to the scaffold response.',
    ],
  };

  assert.equal(
    implementationJudgmentCanComplete({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('passing implementation judgments ignore weak note quality as non-code repair', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.78,
    passed: true,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'implementation_note_quality',
        score: 3,
        weight: 5,
        evidence: 'The implementation note has an inconsistent files-touched summary.',
      },
    ],
  };

  assert.deepEqual(implementationWeakDimensionRemediation(judgment), []);
  assert.equal(
    implementationJudgmentCanComplete({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
    }),
    true,
  );
});

test('contract-only tasks ignore non-actionable database state dimension complaints', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.82,
    passed: true,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'The task does not show database CHECK constraints or indexes.',
      },
    ],
  };
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain/profile.ts'],
    },
  ]);

  assert.deepEqual(implementationWeakDimensionRemediation(judgment, plan.tasks[0]), []);
  assert.equal(
    implementationJudgmentCanComplete({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
      task: plan.tasks[0],
    }),
    true,
  );
});

test('contract-only tasks can proceed when only database state remediation lowers the implementation score', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.675,
    passed: false,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 2,
        weight: 7,
        evidence: 'The adapter does not show database CHECK constraints or indexes.',
      },
      { id: 'implementation_note_quality', score: 4, weight: 5, evidence: 'honest and complete' },
    ],
    remediation: [
      'DIMENSION state_explicitness scored 2/5 (The adapter does not show database CHECK constraints or indexes.). Target: Explicit lifecycle states with CHECK constraints, timestamps, and indexes.',
    ],
  };
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/services/bookmarkClient.ts'],
    },
  ]);

  assert.deepEqual(implementationActionableJudgmentRemediation(judgment, plan.tasks[0]), []);
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
      task: plan.tasks[0],
    }),
    true,
  );
});

test('state-owning tasks still repair weak state explicitness dimensions', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.82,
    passed: true,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 3,
        weight: 7,
        evidence: 'The schema lacks database CHECK constraints or indexes.',
      },
    ],
  };
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
  ]);

  assert.deepEqual(implementationWeakDimensionRemediation(judgment, plan.tasks[0]), [
    'DIMENSION state_explicitness scored 3/5. Improve this before continuing: The schema lacks database CHECK constraints or indexes.',
  ]);
});

test('state-owning tasks keep database state remediation actionable', () => {
  const judgment = {
    ...implementationJudgment,
    overall: 0.675,
    passed: false,
    dimensions_scored: [
      { id: 'smallest_coherent_change', score: 5, weight: 8, evidence: 'ok' },
      {
        id: 'state_explicitness',
        score: 2,
        weight: 7,
        evidence: 'The schema lacks database CHECK constraints or indexes.',
      },
    ],
    remediation: [
      'DIMENSION state_explicitness scored 2/5 (The schema lacks database CHECK constraints or indexes.). Target: Explicit lifecycle states with CHECK constraints, timestamps, and indexes.',
    ],
  };
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['migrations/0001_schema.sql'],
    },
  ]);

  assert.deepEqual(implementationActionableJudgmentRemediation(judgment, plan.tasks[0]), judgment.remediation);
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment,
      deterministicResults: [{ id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' }],
      note: implementationNote,
      task: plan.tasks[0],
    }),
    false,
  );
});

test('missing owned surfaces block the non-actionable implementation fast path', () => {
  assert.equal(
    shouldProceedAfterNonActionableImplementationJudgment({
      judgment: implementationJudgment,
      deterministicResults: [
        { id: 'module_loads', check: 'ran_code_before_complete', passed: true, reason: 'ok' },
        {
          id: 'owned_surfaces_present',
          check: 'owned_surfaces_present',
          passed: false,
          reason: 'missing owned surfaces: src/ai/client.ts',
        },
      ],
      note: implementationNote,
    }),
    false,
  );
});

test('deterministic implementation blockers produce retry remediation before model judging', () => {
  assert.deepEqual(
    implementationDeterministicRemediation([
      { id: 'owned_surfaces_present', check: 'owned_surfaces_present', passed: false, reason: 'missing owned surfaces: src/ai/client.ts' },
      { id: 'preflight_stubs_replaced', check: 'preflight_stubs_replaced', passed: false, reason: 'preflight stubs remain: src/routes/runs.ts' },
      { id: 'verification_passed', check: 'build_verification_passed', passed: false, reason: 'npm run typecheck failed: TS1128' },
      { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', passed: false, reason: 'bcrypt found' },
    ]),
    [
      'DETERMINISTIC owned_surfaces_present failed: missing owned surfaces: src/ai/client.ts',
      'DETERMINISTIC preflight_stubs_replaced failed: preflight stubs remain: src/routes/runs.ts',
      'DETERMINISTIC verification_passed failed: npm run typecheck failed: TS1128',
    ],
  );
});

test('typescript diagnostics are extracted from verification remediation for focused repair packets', () => {
  const failure = `npm run typecheck failed: Command failed: npm run typecheck

stdout:

> talking-head-builder@0.1.0 typecheck
> tsc --noEmit

src/ai/profilePrompts.ts(304,37): error TS18046: 'value' is of type 'unknown'.
src/ai/profilePrompts.ts(304,51): error TS18046: 'value' is of type 'unknown'.
src/ai/profilePrompts.ts(304,51): error TS18046: 'value' is of type 'unknown'.
`;

  assert.deepEqual(typeScriptDiagnosticsFromText(failure), [
    {
      path: 'src/ai/profilePrompts.ts',
      line: 304,
      column: 37,
      code: 'TS18046',
      message: "'value' is of type 'unknown'.",
    },
    {
      path: 'src/ai/profilePrompts.ts',
      line: 304,
      column: 51,
      code: 'TS18046',
      message: "'value' is of type 'unknown'.",
    },
  ]);
  assert.deepEqual(
    typeScriptDiagnosticsFromRemediation([`DETERMINISTIC verification_passed failed: ${failure}`]).map(
      (diagnostic) => `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}`,
    ),
    ['src/ai/profilePrompts.ts:304:37 TS18046', 'src/ai/profilePrompts.ts:304:51 TS18046'],
  );
});

test('unknown Number.isInteger auto repair is scoped to the current task boundary', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-unknown-number-repair-'));
  mkdirSync(join(repoPath, 'src/ai'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/ai/profilePrompts.ts'),
    [
      'function isScore(value: unknown): value is number {',
      '  return Number.isInteger(value) && value >= 0 && value <= 10;',
      '}',
      '',
    ].join('\n'),
  );
  mkdirSync(join(repoPath, 'src/other'), { recursive: true });
  writeFileSync(
    join(repoPath, 'src/other/outside.ts'),
    [
      'function isScore(value: unknown): value is number {',
      '  return Number.isInteger(value) && value >= 0 && value <= 10;',
      '}',
      '',
    ].join('\n'),
  );

  const plan = taskPlan([
    { id: 'T06', depends_on: [], owned_surfaces: ['src/ai/profilePrompts.ts'] },
    { id: 'T99', depends_on: ['T06'], owned_surfaces: ['src/other/outside.ts'] },
  ]);
  const failure = [
    "src/ai/profilePrompts.ts(2,37): error TS18046: 'value' is of type 'unknown'.",
    "src/other/outside.ts(2,37): error TS18046: 'value' is of type 'unknown'.",
  ].join('\n');

  assert.equal(
    await repairUnknownNumberIntegerNarrowing({
      repoPath,
      stage: 'build:T06',
      taskPlan: plan,
      currentTaskIndex: 0,
      failure,
    }),
    true,
  );
  assert.match(
    readFileSync(join(repoPath, 'src/ai/profilePrompts.ts'), 'utf8'),
    /typeof value === "number" && Number\.isInteger\(value\) && value >= 0/,
  );
  assert.doesNotMatch(
    readFileSync(join(repoPath, 'src/other/outside.ts'), 'utf8'),
    /typeof value === "number"/,
  );
});

test('reusable implementation artifacts require passing judgment and present owned surfaces', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-artifact-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.deepEqual(reusableImplementationArtifactForTask(repoPath, task), {
    note: {
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/index.ts'],
    },
    notePath: '.delivery/artifacts/note-T1.a1.json',
    judgment: {
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    },
    judgmentPath: '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json',
    judgeOutputPath: undefined,
    attempt: 1,
  });
});

test('reusable implementation artifacts reject stale Worker AI config artifacts', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-ai-binding-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\n# [ai]\n# binding = "AI"\n');
  writeFileSync(
    join(repoPath, 'src/index.ts'),
    'import { createAiClient } from "./ai/client";\nexport interface Env { AI?: Ai }\nexport const load = (env: Env) => createAiClient(env);\n',
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['wrangler.toml', 'src/index.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['wrangler.toml', 'src/index.ts'] }]).tasks;

  assert.equal(reusableImplementationArtifactForTask(repoPath, task), undefined);
});

test('build resume plan points to the next task after the passing artifact prefix', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-resume-plan-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/one.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'src/two.ts'), 'export {};\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['src/one.ts'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/one.ts'] },
    { depends_on: ['T1'], owned_surfaces: ['src/two.ts'] },
  ]);

  assert.deepEqual(deliveryBuildResumePlan(repoPath, plan), {
    reusableTaskIds: ['T1'],
    resumeAfterTaskId: 'T1',
    nextTaskId: 'T2',
    totalTasks: 2,
  });
});

test('reusable implementation artifacts reject notes outside role ownership', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-reuse-boundary-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'public'), { recursive: true });
  mkdirSync(join(repoPath, '.delivery/artifacts/judgments'), { recursive: true });
  writeFileSync(join(repoPath, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(repoPath, 'public/index.html'), '<!doctype html>\n');
  writeFileSync(
    join(repoPath, '.delivery/artifacts/note-T1.a1.json'),
    JSON.stringify({
      ...implementationNote,
      task: 'T1',
      files_touched: ['public/index.html'],
    }),
  );
  writeFileSync(
    join(repoPath, '.delivery/artifacts/judgments/implementation-T1-a1.judgment.json'),
    JSON.stringify({
      rubric: 'implementation',
      overall: 0.91,
      passed: true,
      gates_failed: [],
      dimensions_missing: [],
    }),
  );
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/index.ts'] }]).tasks;

  assert.equal(reusableImplementationArtifactForTask(repoPath, task), undefined);
});

test('build task preparation pauses after earlier stopped tasks', () => {
  const plan = taskPlan([
    { depends_on: [], owned_surfaces: ['src/setup.ts'] },
    { depends_on: [], owned_surfaces: ['src/profile.ts'] },
    { depends_on: [], owned_surfaces: ['src/weekly.ts'] },
  ]);

  assert.deepEqual(
    priorStoppedBuildTaskIds({
      taskPlan: plan,
      taskIndex: 2,
      taskStatuses: {
        T1: { status: 'complete' },
        T2: { status: 'stuck' },
      },
    }),
    ['T2'],
  );
});

test('implementation retry mode focuses timeout retries when owned files already exist', () => {
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt timed out after 180000ms. Create missing owned surfaces.'],
      missingSurfaces: ['src/routes/profiles.ts'],
    }),
    'write-first',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt timed out after 180000ms. Edit the boundary surfaces.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt made no tool calls after 60000ms. Create the missing owned surfaces.'],
      missingSurfaces: ['src/routes/profiles.ts'],
    }),
    'write-first',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['T3 build attempt made no tool calls after 60000ms. Make a focused write to the boundary surfaces.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['DETERMINISTIC verification_passed failed: npm run typecheck failed: TS2307'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
  assert.equal(
    implementationRetryMode({
      remediation: ['GATE no_silent_degradation failed: record or surface the non-fatal AI summary failure.'],
      missingSurfaces: [],
    }),
    'focused-repair',
  );
});

test('implementation repair retries require a tool call', () => {
  assert.equal(implementationToolChoiceForRetryMode('normal'), 'auto');
  assert.equal(implementationToolChoiceForRetryMode('write-first'), 'required');
  assert.equal(implementationToolChoiceForRetryMode('replace-stubs'), 'required');
  assert.equal(implementationToolChoiceForRetryMode('focused-repair'), 'required');
});

test('build no-tool remediation preserves prior judge findings during repair', () => {
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['src/storage/bookmarks.ts'] }]).tasks;
  const remediation = buildTimeoutRemediation({
    task,
    timeoutMs: 60000,
    missingSurfaces: [],
    repairRecovery: true,
    noToolCall: true,
    priorRemediation: [
      'GATE no_silent_degradation failed: parse helpers must throw on corrupted persisted JSON.',
      'DIMENSION error_response_quality scored 2/5.',
    ],
  });

  assert.match(remediation[0], /repair attempt made no tool calls/);
  assert.match(remediation.join('\n'), /no_silent_degradation/);
  assert.match(remediation.join('\n'), /error_response_quality/);
});

test('latestSuccessfulWorkspaceWriteEventTimestamp tracks writes in the latest stage attempt', () => {
  const timestamp = latestSuccessfulWorkspaceWriteEventTimestamp(
    [
      { type: 'stage_start', stage: 'build:T1', role: 'engineer', ts: '2026-07-06T10:00:00.000Z' },
      { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_write_file', ok: true, ts: '2026-07-06T10:01:00.000Z' },
      { type: 'stage_end', stage: 'build:T1', reason: 'max_turns', ts: '2026-07-06T10:02:00.000Z' },
      { type: 'stage_start', stage: 'build:T1', role: 'engineer', ts: '2026-07-06T10:03:00.000Z' },
      { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_read_file', ok: true, ts: '2026-07-06T10:04:00.000Z' },
      { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_edit_file', ok: false, ts: '2026-07-06T10:05:00.000Z' },
      { type: 'tool_use', stage: 'build:T1', tool: 'mastra_workspace_edit_file', ok: true, ts: '2026-07-06T10:06:00.000Z' },
    ],
    { stage: 'build:T1' },
  );

  assert.equal(timestamp, Date.parse('2026-07-06T10:06:00.000Z'));
});

test('latestSuccessfulWorkspaceWriteEventTimestamp ignores read-only stages', () => {
  const timestamp = latestSuccessfulWorkspaceWriteEventTimestamp(
    [
      { type: 'stage_start', stage: 'build:T2', role: 'engineer', ts: '2026-07-06T10:00:00.000Z' },
      { type: 'tool_use', stage: 'build:T2', tool: 'mastra_workspace_list_files', ok: true, ts: '2026-07-06T10:01:00.000Z' },
      { type: 'tool_use', stage: 'build:T2', tool: 'mastra_workspace_read_file', ok: true, ts: '2026-07-06T10:02:00.000Z' },
    ],
    { stage: 'build:T2' },
  );

  assert.equal(timestamp, undefined);
});

test('readBudgetBlockedToolCount tracks pre-write read-budget events in the latest stage attempt', () => {
  const events = [
    { type: 'stage_start', stage: 'build:T2', role: 'engineer', ts: '2026-07-06T10:00:00.000Z' },
    {
      type: 'tool_use',
      stage: 'build:T2',
      tool: 'mastra_workspace_read_file',
      ok: false,
      error: 'Build stage build:T2 already used 6 read/list tool calls before any write. Stop investigating.',
      ts: '2026-07-06T10:00:10.000Z',
    },
    { type: 'stage_end', stage: 'build:T2', reason: 'max_turns', ts: '2026-07-06T10:00:20.000Z' },
    { type: 'stage_start', stage: 'build:T2', role: 'engineer', ts: '2026-07-06T10:01:00.000Z' },
    {
      type: 'tool_use',
      stage: 'build:T2',
      tool: 'mastra_workspace_list_files',
      ok: false,
      error: 'Build stage build:T2 already used 6 read/list tool calls before any write. Stop investigating.',
      ts: '2026-07-06T10:01:10.000Z',
    },
    {
      type: 'tool_use',
      stage: 'build:T2',
      tool: 'mastra_workspace_read_file',
      ok: false,
      error: 'Build stage build:T2 already used 6 read/list tool calls before any write. Stop investigating.',
      ts: '2026-07-06T10:01:20.000Z',
    },
  ];

  assert.equal(readBudgetBlockedToolCount(events, { stage: 'build:T2' }), 2);
});

test('implementation retry mode classifies deterministic failure families', () => {
  const missingSurfaceRemediation = ['DETERMINISTIC owned_surfaces_present failed: missing owned surfaces: src/routes/runs.ts'];
  assert.equal(implementationFailureClass(missingSurfaceRemediation), 'missing_surface');
  assert.equal(
    implementationRetryMode({
      remediation: missingSurfaceRemediation,
      missingSurfaces: ['src/routes/runs.ts'],
    }),
    'write-first',
  );

  const preflightStubRemediation = [
    'DETERMINISTIC preflight_stubs_replaced failed: preflight stubs remain: src/workflows/steps/create-briefs.ts',
  ];
  assert.equal(implementationFailureClass(preflightStubRemediation), 'preflight_stub');
  assert.equal(
    implementationRetryMode({
      remediation: preflightStubRemediation,
      missingSurfaces: [],
    }),
    'replace-stubs',
  );
  assert.equal(
    implementationRetryMode({
      remediation: [
        'T04 repair attempt made no tool calls after 60000ms. Make a focused write to the existing boundary surfaces before returning.',
        ...preflightStubRemediation,
      ],
      missingSurfaces: [],
      unreplacedStubs: ['src/workflows/steps/create-briefs.ts'],
    }),
    'replace-stubs',
  );
  assert.equal(
    implementationFailureClass([
      'T05 build attempt timed out after 180000ms.',
      'DETERMINISTIC preflight_stubs_replaced failed: preflight stubs remain: src/storage/candidates.ts',
    ]),
    'preflight_stub',
  );

  const policyBoundaryRemediation = [
    'DETERMINISTIC file_ownership failed: wrangler.toml is outside engineer owned globs',
  ];
  assert.equal(implementationFailureClass(policyBoundaryRemediation), 'policy_boundary');
  assert.equal(
    implementationRetryMode({
      remediation: policyBoundaryRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  assert.equal(
    implementationFailureClass(['T2 build attempt made no tool calls after 60000ms. Make a focused write.']),
    'model_no_action',
  );

  const readBudgetRemediation = [
    'READ_BUDGET_EXCEEDED T8: the build attempt exhausted the pre-write read/list budget before creating owned surfaces.',
  ];
  assert.equal(implementationFailureClass(readBudgetRemediation), 'read_budget');
  assert.equal(
    implementationRetryMode({
      remediation: readBudgetRemediation,
      missingSurfaces: ['src/routes/profiles.ts'],
    }),
    'write-first',
  );
  assert.equal(
    implementationRetryMode({
      remediation: readBudgetRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );

  const judgeTimeoutRemediation = [
    'JUDGE_TIMEOUT T7.a2: implementation judgment timed out after 300000ms. Preserve working code and retry.',
  ];
  assert.equal(implementationFailureClass(judgeTimeoutRemediation), 'judge_timeout');
  assert.equal(
    implementationRetryMode({
      remediation: judgeTimeoutRemediation,
      missingSurfaces: [],
    }),
    'focused-repair',
  );
});

test('timed out build attempts can be salvaged only after edits resolve owned surfaces and stubs', () => {
  assert.equal(
    canSalvageTimedOutBuildAttempt({
      stageHadToolUse: true,
      missingSurfaces: [],
      unreplacedStubs: [],
    }),
    true,
  );
  assert.equal(
    canSalvageTimedOutBuildAttempt({
      stageHadToolUse: false,
      missingSurfaces: [],
      unreplacedStubs: [],
    }),
    false,
  );
  assert.equal(
    canSalvageTimedOutBuildAttempt({
      stageHadToolUse: true,
      missingSurfaces: [],
      unreplacedStubs: ['src/storage/candidates.ts'],
    }),
    false,
  );
});
