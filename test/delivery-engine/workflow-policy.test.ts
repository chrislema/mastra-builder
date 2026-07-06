import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildTimeoutRemediation,
  canSalvageTimedOutBuildAttempt,
  createMissingOwnedSurfaceStubs,
  deliveryBuildResumePlan,
  directDependencySurfacePaths,
  implementationActionableJudgmentRemediation,
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
  normalizeReadoutSafeAdapterAmbiguities,
  missingOwnedSurfacePaths,
  normalizeTaskPlanProfileContractDependencies,
  normalizeTaskPlanScaffoldDependencies,
  normalizeTaskPlanRoleBoundaries,
  operatorDocumentationHygiene,
  openDecisionHygiene,
  ownedSurfaceHygiene,
  profileContractDependencyHygiene,
  profileKindContractGaps,
  profileKindTaskPacketPolicy,
  profileKindTaskPacketPolicyForTask,
  outOfPlanVerificationFailurePaths,
  priorStoppedBuildTaskIds,
  projectScaffoldHygiene,
  readBudgetBlockedToolCount,
  repairStaleDownstreamVerificationSurfaces,
  repairUnknownNumberIntegerNarrowing,
  releaseGateForInvalidTesterOutput,
  releaseGateEvidenceCommandPlan,
  releaseGateLocalD1DatabaseName,
  releaseGateRuntimeProbePlan,
  releaseGateRequiredEvidencePassed,
  releaseGateStaticEvidenceResults,
  releaseGateTranscriptFixtureSchemaGaps,
  releaseGateWorkerDevCommand,
  routeMiddlewareBypassGaps,
  reusableImplementationArtifactForTask,
  shouldProceedAfterNonActionableImplementationJudgment,
  shouldSuspendForPlannerQuestions,
  staleDownstreamVerificationSurfacePaths,
  taskOwnedSurfaceRoleHygiene,
  taskBoundarySurfaces,
  typeScriptDiagnosticsFromRemediation,
  typeScriptDiagnosticsFromText,
  unreplacedPreflightStubPaths,
  verificationWithAcceptanceGaps,
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

const readout = (blocking_ambiguities: string[]) => ({
  artifact_type: 'readout' as const,
  product_intent: 'intent',
  technical_shape: 'shape',
  safe_assumptions: [],
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
  technology_decisions: [],
  open_decisions: [],
  risks: [],
});

test('planner questions are deferred when a task plan has an executable root task', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(readout(['Confirm downstream integration detail.']), taskPlan([{ depends_on: [] }])),
    false,
  );
});

test('planner questions suspend when no executable root task exists', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(
      readout(['Implementation impossible: the spec explicitly marks the required upstream API contract TBD.']),
      taskPlan([]),
    ),
    true,
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
      owned_surfaces: ['package.json', 'tsconfig.json'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.toml', 'src/env.ts', 'src/index.ts'],
    },
  ]);
  const packageOnlyResult = projectScaffoldHygiene(repoPath, packageOnlyPlan);
  assert.equal(packageOnlyResult.passed, false);
  assert.match(packageOnlyResult.reason, /no TypeScript source input/);

  const goodPlan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.toml', 'src/env.ts'],
    },
  ]);
  assert.deepEqual(projectScaffoldHygiene(repoPath, goodPlan), { passed: true, reason: 'ok' });
});

test('bare Worker project plans normalize root static assets behind the package scaffold', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-project-scaffold-normalize-'));
  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts'],
    },
    {
      depends_on: ['T1'],
      owned_surfaces: ['wrangler.toml'],
    },
    {
      depends_on: [],
      owned_surfaces: ['public/index.html', 'public/styles.css'],
    },
  ]);

  const normalized = normalizeTaskPlanScaffoldDependencies(repoPath, plan);

  assert.deepEqual(normalized.tasks[0].owned_surfaces, ['package.json', 'tsconfig.json', 'src/index.ts', '.gitignore']);
  assert.match(normalized.tasks[0].acceptance_criteria.join('\n'), /\.delivery/);
  assert.deepEqual(normalized.tasks[2].depends_on, ['T1']);
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
  mkdirSync(join(repoPath, 'src', 'domain'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'domain', 'profileArtifacts.ts'), 'export const PROFILE_KINDS = ["creator"] as const;\n');

  const plan = taskPlan([
    {
      depends_on: [],
      owned_surfaces: ['src/domain/profileArtifacts.ts'],
    },
  ]);

  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /audience_segments, voice_profile/);
  assert.match(profileKindContractGaps(repoPath, plan.tasks[0]).join('\n'), /generic creator kind/);

  writeFileSync(
    join(repoPath, 'src', 'domain', 'profileArtifacts.ts'),
    'export const PROFILE_KINDS = ["audience_segments", "voice_profile"] as const;\n',
  );

  assert.deepEqual(profileKindContractGaps(repoPath, plan.tasks[0]), []);
});

test('profile kind contract treats profileKinds module as the producer surface', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-profile-kinds-contract-'));
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
  assert.equal(profileKindTaskPacketPolicy().producer_surfaces.includes('src/contracts.ts'), true);
});

test('profile kind task packet policy names required persistent kinds', () => {
  assert.deepEqual(profileKindTaskPacketPolicy().required_persistent_kinds, ['audience_segments', 'voice_profile']);
  assert.equal(profileKindTaskPacketPolicy().producer_surfaces.includes('src/domain/profileKinds.ts'), true);
  assert.match(profileKindTaskPacketPolicy().guidance, /Do not substitute generic creator/);
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
  assert.deepEqual(profileKindTaskPacketPolicyForTask(profileTask)?.required_persistent_kinds, [
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
      'Task plan does not include README.md operator documentation. Add an engineer-owned README.md task that captures local Wrangler validation, required Cloudflare resources/bindings, git/gh source control, and human-approved wrangler deploy.',
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
          command: 'npm run dev -- --ip 127.0.0.1 --port 8787 --persist-to /tmp/state',
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
  assert.match(report.next_action, /fix required local validation failures/);
  assert.equal(report.issues.length, 1);
  assert.match(report.issues[0].action, /production approval/);
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
      { tier: 'api', command: 'npx wrangler d1 migrations apply demo-db --local', required: true },
    ],
  );
  assert.deepEqual(
    releaseGateEvidenceCommandPlan(repoPath, '/tmp/probe-state').map((command) => command.command),
    [
      'npm run typecheck',
      'npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/probe-state',
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
      {
        tier: 'api',
        command: 'npx wrangler d1 migrations apply talking-head-builder --local --persist-to /tmp/probe-state',
        required: true,
      },
    ],
  );
});

test('release gate Wrangler commands prefer the installed local binary', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-local-wrangler-'));
  mkdirSync(join(repoPath, 'migrations'), { recursive: true });
  mkdirSync(join(repoPath, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(repoPath, 'node_modules/.bin/wrangler'), '#!/usr/bin/env node\n');
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
    './node_modules/.bin/wrangler d1 migrations apply demo-db --local',
  );
  assert.equal(releaseGateWorkerDevCommand(repoPath, 8787)?.command, './node_modules/.bin/wrangler dev --ip 127.0.0.1 --port 8787');
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

test('release gate runtime probe planner uses the project Wrangler dev script', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-'));
  mkdirSync(join(repoPath, 'src/routes'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'wrangler dev' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'wrangler.toml'), 'name = "demo-worker"\nmain = "src/index.ts"\n');
  writeFileSync(join(repoPath, 'src/routes/health.ts'), 'export const path = "/health";\n');

  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999), {
    command: 'npm run dev -- --ip 127.0.0.1 --port 8999',
    executable: 'npm',
    args: ['run', 'dev', '--', '--ip', '127.0.0.1', '--port', '8999'],
  });
  assert.deepEqual(releaseGateWorkerDevCommand(repoPath, 8999, '/tmp/state'), {
    command: 'npm run dev -- --ip 127.0.0.1 --port 8999 --persist-to /tmp/state',
    executable: 'npm',
    args: ['run', 'dev', '--', '--ip', '127.0.0.1', '--port', '8999', '--persist-to', '/tmp/state'],
  });

  const plan = releaseGateRuntimeProbePlan(repoPath);
  assert.equal(plan?.required, true);
  assert.equal(plan?.command.command, 'npm run dev -- --ip 127.0.0.1 --port <port>');
  assert.deepEqual(
    plan?.probes.map((probe) => ({ path: probe.path, expectedStatus: probe.expectedStatus, statusBelow: probe.statusBelow })),
    [
      { path: '/', expectedStatus: undefined, statusBelow: 500 },
      { path: '/health', expectedStatus: 200, statusBelow: undefined },
    ],
  );
});

test('release gate runtime probe planner covers common Worker API state and error routes', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-runtime-probes-'));
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

test('release gate evidence planner seeds latest transcript and version audit fixtures when schema is present', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-release-transcript-fixture-'));
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
    'npx wrangler d1 migrations apply demo-db --local --persist-to /tmp/probe-state',
    'npx wrangler d1 execute demo-db --local --persist-to /tmp/probe-state --file .delivery/tmp/release-gate-transcript-fixture.sql --json',
    'npx wrangler d1 execute demo-db --local --persist-to /tmp/probe-state --command "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = \'release-gate-transcript-v1\' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = \'release-gate-transcript-v2\' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = \'release-gate-run\') AS active_transcript_id FROM transcripts WHERE run_id = \'release-gate-run\'" --json',
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
    command: 'npx wrangler dev --ip 127.0.0.1 --port 8999',
    executable: 'npx',
    args: ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8999'],
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
    'Workers AI source is present, but the Wrangler config does not contain an active [ai] binding = "AI" section.',
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
        'Workers AI source is present, but the Wrangler config does not contain an active [ai] binding = "AI" section. Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.',
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

test('Worker config hygiene requires current JSONC schema date flags and observability', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-hygiene-'));
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
      {
        $schema: './node_modules/wrangler/config-schema.json',
        name: 'demo-worker',
        main: 'src/index.ts',
        compatibility_date: currentCompatibilityDate(),
        compatibility_flags: ['nodejs_compat'],
        observability: {
          enabled: true,
          head_sampling_rate: 1,
        },
      },
      null,
      2,
    ),
  );

  assert.deepEqual(workerConfigHygieneGaps(repoPath, task), []);
  assert.deepEqual(workerConfigHygieneGaps(repoPath), []);
  assert.equal(
    releaseGateStaticEvidenceResults(repoPath).find((result) => result.command === 'static check: Worker config hygiene')
      ?.ok,
    true,
  );
});

test('Worker release gate fails closed when Wrangler config is missing', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-missing-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { dev: 'wrangler dev', typecheck: 'tsc --noEmit' }, devDependencies: { wrangler: '^4.0.0' } }, null, 2),
  );
  writeFileSync(join(repoPath, 'src/index.ts'), 'export default { fetch: () => new Response("ok") };\n');

  const staticResult = releaseGateStaticEvidenceResults(repoPath).find(
    (result) => result.command === 'static check: Worker config hygiene',
  );

  assert.equal(staticResult?.ok, false);
  assert.equal(staticResult?.required, true);
  assert.match(staticResult?.error ?? '', /No Wrangler config file exists/);
});

test('Worker config hygiene aligns Cloudflare binding names with Env declarations', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-config-env-align-'));
  mkdirSync(join(repoPath, 'src'), { recursive: true });
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
      {
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
      },
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
      {
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
      },
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
});

test('Worker package scaffold hygiene requires current Wrangler tooling and config-based scripts', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-worker-package-hygiene-'));
  const [task] = taskPlan([{ depends_on: [], owned_surfaces: ['package.json', 'tsconfig.json', 'src/index.ts'] }]).tasks;

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev src/index.ts',
          deploy: 'wrangler deploy src/index.ts',
          typecheck: 'tsc --noEmit',
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

  const gaps = workerPackageScaffoldGaps(repoPath, task);
  assert.match(gaps.join('\n'), /scripts\.dev/);
  assert.match(gaps.join('\n'), /scripts\.deploy/);
  assert.match(gaps.join('\n'), /wrangler.*v4\+/);
  assert.match(gaps.join('\n'), /workers-types.*last 90 days/);
  assert.match(gaps.join('\n'), /frontend framework\/build dependencies.*react.*vite/);
  assert.match(gaps.join('\n'), /scripts\.build uses a frontend framework\/bundler/);
  assert.match(gaps.join('\n'), /tsconfig\.json: missing/);
  assert.match(gaps.join('\n'), /\.gitignore is missing/);

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
          typecheck: 'tsc --noEmit',
        },
        devDependencies: {
          '@cloudflare/workers-types': 'latest',
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
          types: ['@cloudflare/workers-types'],
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(repoPath, '.gitignore'), ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars', '.env', ''].join('\n'));

  assert.deepEqual(workerPackageScaffoldGaps(repoPath, task), []);
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
