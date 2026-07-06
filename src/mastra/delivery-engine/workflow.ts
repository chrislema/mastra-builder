import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  finishDeliveryRunState,
  readDeliveryEventsState,
  initializeDeliveryRunState,
  readDeliveryRunState,
  recordDeliveryArtifactState,
  recordDeliveryJudgmentState,
  startDeliveryStageState,
  updateDeliveryTaskState,
} from './state-service';
import { readDeliveryEvents, writeDeliveryArtifact, type DeliveryRunStatus } from './state';
import {
  dependencyGraphAcyclic,
  fileOwnership,
  matchesAny,
  noBcryptWeakHash,
  normalizeDeliveryPathReference,
  planSchemaComplete,
  runDeterministicCheck,
  stageSlice,
  type DeliveryEvent,
} from './checks';
import { createDeliveryRequestContext } from './context';
import {
  aggregateJudgment,
  buildJudgeArtifactPrompt,
  deterministicCheckNameForGate,
  judgeOutputSchemaForRubric,
  loadDeliveryEngineRubric,
  type AggregatedJudgment,
  type DeterministicGateResult,
  type JudgeOutput,
  type Rubric,
} from './judgment';
import {
  deliveryBuildStepScorers,
  deliveryDeploymentStepScorers,
  deliveryPlanStepScorers,
  deliveryReleaseGateStepScorers,
  deliveryReviewStepScorers,
} from './scorers';
import { safePersistDeliveryStateWithMastra } from './observability';
import { deliveryStructuredOutputOptions, deliveryToolStructuredOutputOptions } from './models';
import { parseDeliveryStructuredOutput } from './structured-output';

const execFileAsync = promisify(execFile);

const workflowInputSchema = z.object({
  repoPath: z.string().describe('Absolute path to the target repo.'),
  visionPath: z.string().describe('Path to vision.md inside repoPath; relative paths are resolved under repoPath.'),
  specPath: z.string().describe('Path to spec.md inside repoPath; relative paths are resolved under repoPath.'),
  maxRetries: z.number().int().min(0).default(2),
  deployMode: z.enum(['mock', 'real']).default('mock'),
  reviewMode: z.enum(['fast', 'thorough']).default('fast'),
});

const taskSchema = z.object({
  id: z.string(),
  owner: z.enum(['engineer', 'designer']),
  deliverable: z.string(),
  depends_on: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  owned_surfaces: z.array(z.string()),
});

const readoutSchema = z.object({
  artifact_type: z.literal('readout'),
  product_intent: z.string(),
  technical_shape: z.string(),
  safe_assumptions: z.array(z.string()),
  blocking_ambiguities: z.array(z.string()),
  recommended_next_step: z.string(),
});

const taskPlanSchema = z.object({
  artifact_type: z.literal('task-plan'),
  scope: z.string(),
  tasks: z.array(taskSchema),
  technology_decisions: z.array(z.object({ decision: z.string(), rationale: z.string() })).default([]),
  open_decisions: z.array(z.string()),
  risks: z.array(z.string()),
});

const reviewFindingSchema = z.object({
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  location: z.string().optional(),
  evidence: z.string(),
  why_it_matters: z.string(),
  required_remediation: z.string(),
});

const reviewReportSchema = z.object({
  artifact_type: z.literal('review-report'),
  verdict: z.enum(['approved', 'approved_with_conditions', 'blocked']),
  findings: z.array(reviewFindingSchema),
  conditions: z.array(z.string()).default([]),
  residual_risks: z.array(z.string()),
  recommended_next_step: z.string(),
});

function compactDiagnostic(error: unknown, limit = 600) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
}

function parseReviewReportResponse(response: unknown, label: string) {
  try {
    return {
      report: parseDeliveryStructuredOutput(reviewReportSchema, response, label),
      repairedFromBareFindings: false,
    };
  } catch (error) {
    const findings = parseDeliveryStructuredOutput(z.array(reviewFindingSchema), response, `${label} findings`);
    return {
      report: {
        artifact_type: 'review-report' as const,
        verdict: findings.length ? ('blocked' as const) : ('approved' as const),
        findings,
        conditions: [],
        residual_risks: [],
        recommended_next_step: findings.length
          ? 'Revise the task plan to resolve the listed findings before implementation begins.'
          : 'Run the delivery build loop against the approved task plan.',
      },
      repairedFromBareFindings: true,
      repairReason: compactDiagnostic(error),
    };
  }
}

const implementationNoteSchema = z.object({
  artifact_type: z.literal('implementation-note'),
  task: z.string(),
  changes: z.array(z.string()).min(1),
  files_touched: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  verification: z.object({
    performed: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
  }),
  risks: z.array(z.string()).default([]),
});

const releaseGateSchema = z.object({
  artifact_type: z.literal('release-gate'),
  decision: z.enum(['pass', 'fail']),
  event_type: z.enum(['commit', 'push', 'pull_request', 'pre_deployment', 'production_deploy']),
  tiers: z.array(
    z.object({
      tier: z.enum(['smoke', 'api', 'e2e', 'full_matrix']),
      status: z.enum(['passed', 'failed', 'skipped', 'not_required']),
      run_ref: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
  critical_areas: z.array(
    z.object({
      area: z.enum(['auth', 'billing', 'state_integrity', 'data_safety', 'deployment_correctness', 'error_responses']),
      status: z.enum(['verified', 'missing', 'not_applicable']),
      evidence: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
  blockers: z.array(z.string()),
  cosmetic_issues: z.array(z.string()),
  summary: z.string(),
});

const deploymentReportSchema = z.object({
  artifact_type: z.literal('deployment-report'),
  environment: z.string(),
  revision: z.string(),
  migrations_applied: z.array(z.string()).default([]),
  config_changes: z.array(z.string()).default([]),
  result: z.enum(['success', 'failure']),
  verification: z.array(
    z.object({
      check: z.string(),
      expected: z.string().optional(),
      actual: z.string(),
      passed: z.boolean().optional(),
    }),
  ),
  issues: z.array(
    z.object({
      description: z.string(),
      impact: z.string(),
      action: z.string(),
    }),
  ),
  next_action: z.enum(['monitor', 'rollback', 'proceed']),
  rollback: z.object({
    prior_revision: z.string(),
    steps: z.string(),
    data_caveats: z.string().optional(),
  }),
});

const plannerOutputSchema = z.object({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
});

const plannerPolicyVersion = 'role-boundary-normalized-v11';

const plannerCacheSchema = z.object({
  sourceFingerprint: z.string(),
  policyVersion: z.string().optional(),
  createdAt: z.string(),
});

function plannerSourceFingerprint(sourceDocuments: Array<{ path: string; content: string }>) {
  return createHash('sha256').update(JSON.stringify(sourceDocuments)).digest('hex');
}

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  if (!existsSync(fullPath)) return undefined;
  return JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
}

function readCachedPlannerOutput({
  repoPath,
  sourceFingerprint,
}: {
  repoPath: string;
  sourceFingerprint: string;
}) {
  if (process.env.DELIVERY_REUSE_PLAN_CACHE === '0') return undefined;

  const readout = readoutSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/readout.json'));
  const taskPlan = taskPlanSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/task-plan.json'));
  if (!readout.success || !taskPlan.success) return undefined;

  const cache = plannerCacheSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/plan-cache.json'));
  if (cache.success && cache.data.sourceFingerprint !== sourceFingerprint) return undefined;
  if (cache.success && cache.data.policyVersion !== plannerPolicyVersion) return undefined;
  if (!openDecisionHygiene(taskPlan.data).passed) return undefined;
  if (!ownedSurfaceHygiene(taskPlan.data).passed) return undefined;
  if (!taskOwnedSurfaceRoleHygiene(taskPlan.data).passed) return undefined;
  if (!projectScaffoldHygiene(repoPath, taskPlan.data).passed) return undefined;

  return { readout: readout.data, taskPlan: taskPlan.data, cacheValidated: cache.success };
}

const testerOutputSchema = z.object({
  gate: releaseGateSchema,
});

const deployerOutputSchema = z.object({
  report: deploymentReportSchema,
});

const plannerRevisionOutputSchema = z.object({
  taskPlan: taskPlanSchema,
});

function parsePlannerRevisionResponse(response: unknown, label: string) {
  try {
    return {
      revision: parseDeliveryStructuredOutput(plannerRevisionOutputSchema, response, label),
      repairedFromBareTaskPlan: false,
    };
  } catch (error) {
    const taskPlan = parseDeliveryStructuredOutput(taskPlanSchema, response, `${label} taskPlan`);
    return {
      revision: { taskPlan },
      repairedFromBareTaskPlan: true,
      repairReason: compactDiagnostic(error),
    };
  }
}

const initializedSchema = workflowInputSchema.extend({
  runId: z.string(),
});

const plannerArtifactsSchema = initializedSchema.extend({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
  artifacts: z.array(z.string()),
});

const plannerQuestionAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

const plannerQuestionsResumeSchema = z.object({
  answers: z.array(plannerQuestionAnswerSchema).min(1),
  notes: z.string().optional(),
});

const plannerQuestionsSuspendSchema = z.object({
  reason: z.string(),
  questions: z.array(z.string()),
  recommendedNextStep: z.string(),
  readoutPath: z.string(),
  taskPlanPath: z.string(),
});

const judgmentRefSchema = z.object({
  subject: z.string(),
  rubric: z.string(),
  path: z.string(),
  overall: z.number(),
  passed: z.boolean(),
});

const workflowStatusSchema = z.enum([
  'planned',
  'reviewed',
  'built',
  'release_ready',
  'gate_failed',
  'complete',
  'failed',
  'blocked_on_questions',
  'stuck',
]);

const checkSummarySchema = z.object({ check: z.string(), passed: z.boolean(), reason: z.string() });

const workflowOutputSchema = z.object({
  repoPath: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  deployMode: z.enum(['mock', 'real']).optional(),
  reviewMode: z.enum(['fast', 'thorough']).optional(),
  status: workflowStatusSchema,
  runId: z.string(),
  summary: z.string(),
  artifacts: z.array(z.string()),
  checks: z.array(checkSummarySchema),
  judgments: z.array(judgmentRefSchema).default([]),
  questions: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()),
});

const deliveryWorkflowStateSchema = z.object({
  repoPath: z.string().optional(),
  runId: z.string().optional(),
  status: workflowStatusSchema.optional(),
  summary: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  deployMode: z.enum(['mock', 'real']).optional(),
  reviewMode: z.enum(['fast', 'thorough']).optional(),
  artifacts: z.array(z.string()).default([]),
  checks: z.array(checkSummarySchema).default([]),
  judgments: z.array(judgmentRefSchema).default([]),
  questions: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
  taskPlan: taskPlanSchema.optional(),
  releaseGate: releaseGateSchema.optional(),
  deploymentReport: deploymentReportSchema.optional(),
  deploymentReportPath: z.string().optional(),
});

const deliveryStageOutputSchema = workflowOutputSchema.extend({
  repoPath: z.string(),
  maxRetries: z.number().int().min(0),
  deployMode: z.enum(['mock', 'real']),
  reviewMode: z.enum(['fast', 'thorough']).default('fast'),
  taskPlan: taskPlanSchema.optional(),
  releaseGate: releaseGateSchema.optional(),
});
const reviewLoopStateSchema = deliveryStageOutputSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
});
const buildTaskWorkItemSchema = deliveryStageOutputSchema.extend({
  task: taskSchema.optional(),
  taskIndex: z.number().int().min(0).default(0),
  skipped: z.boolean().default(false),
});
const buildTaskAttemptStateSchema = buildTaskWorkItemSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
  taskId: z.string().optional(),
  taskStatus: z.enum(['complete', 'stuck', 'blocked', 'skipped']).optional(),
  remediation: z.array(z.string()).default([]),
});
const buildTaskWorkItemsSchema = z.array(buildTaskWorkItemSchema);
const buildTaskResultSchema = deliveryStageOutputSchema.extend({
  taskId: z.string().optional(),
  taskStatus: z.enum(['complete', 'stuck', 'blocked', 'skipped']).optional(),
});
const buildTaskResultsSchema = z.array(buildTaskResultSchema);
const releaseGateLoopStateSchema = deliveryStageOutputSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
  remediation: z.array(z.string()).default([]),
});
const deploymentReportStageSchema = deliveryStageOutputSchema.extend({
  deploymentReport: deploymentReportSchema.optional(),
  deploymentReportPath: z.string().optional(),
});
const deploymentApprovalResumeSchema = z.object({
  approved: z.boolean(),
  approver: z.string().optional(),
  notes: z.string().optional(),
});
const deploymentApprovalSuspendSchema = z.object({
  reason: z.string(),
  deployMode: z.literal('real'),
  releaseGatePath: z.string(),
  releaseGateSummary: z.string(),
  blockers: z.array(z.string()),
  nextSteps: z.array(z.string()),
});
const planStageOutputSchema = deliveryStageOutputSchema;

type TaskPlan = z.infer<typeof taskPlanSchema>;
type ReviewReport = z.infer<typeof reviewReportSchema>;
type ImplementationNote = z.infer<typeof implementationNoteSchema>;
type ReleaseGate = z.infer<typeof releaseGateSchema>;
type DeploymentReport = z.infer<typeof deploymentReportSchema>;
type JudgmentRef = z.infer<typeof judgmentRefSchema>;
type Task = z.infer<typeof taskSchema>;
type DeliveryWorkflowState = z.infer<typeof deliveryWorkflowStateSchema>;

type CheckSummary = { check: string; passed: boolean; reason: string };

const normalizeDeliveryWorkflowState = (state?: Partial<DeliveryWorkflowState>): DeliveryWorkflowState => ({
  repoPath: state?.repoPath,
  runId: state?.runId,
  status: state?.status,
  summary: state?.summary,
  maxRetries: state?.maxRetries,
  deployMode: state?.deployMode,
  reviewMode: state?.reviewMode,
  artifacts: state?.artifacts ?? [],
  checks: state?.checks ?? [],
  judgments: state?.judgments ?? [],
  questions: state?.questions ?? [],
  nextSteps: state?.nextSteps ?? [],
  taskPlan: state?.taskPlan,
  releaseGate: state?.releaseGate,
  deploymentReport: state?.deploymentReport,
  deploymentReportPath: state?.deploymentReportPath,
});

async function syncDeliveryWorkflowState({
  state,
  setState,
  output,
}: {
  state?: Partial<DeliveryWorkflowState>;
  setState: (state: DeliveryWorkflowState) => Promise<void> | void;
  output: Partial<DeliveryWorkflowState> & {
    repoPath?: string;
    runId?: string;
    status?: z.infer<typeof workflowStatusSchema>;
    summary?: string;
    artifacts?: string[];
    checks?: CheckSummary[];
    judgments?: JudgmentRef[];
    questions?: string[];
    nextSteps?: string[];
  };
}) {
  const current = normalizeDeliveryWorkflowState(state);
  await setState({
    ...current,
    repoPath: output.repoPath ?? current.repoPath,
    runId: output.runId ?? current.runId,
    status: output.status ?? current.status,
    summary: output.summary ?? current.summary,
    maxRetries: output.maxRetries ?? current.maxRetries,
    deployMode: output.deployMode ?? current.deployMode,
    reviewMode: output.reviewMode ?? current.reviewMode,
    artifacts: output.artifacts ?? current.artifacts,
    checks: output.checks ?? current.checks,
    judgments: output.judgments ?? current.judgments,
    questions: output.questions ?? current.questions,
    nextSteps: output.nextSteps ?? current.nextSteps,
    taskPlan: output.taskPlan ?? current.taskPlan,
    releaseGate: output.releaseGate ?? current.releaseGate,
    deploymentReport: output.deploymentReport ?? current.deploymentReport,
    deploymentReportPath: output.deploymentReportPath ?? current.deploymentReportPath,
  });
}

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((check) => ({
    check: `${check.check ?? check.id ?? 'unknown'}${suffix ? `:${suffix}` : ''}`,
    passed: check.passed,
    reason: check.reason ?? 'deterministic check',
  }));

const openDecisionRequiredFields = ['topic', 'why it matters', 'options considered', 'follow-up impact'];

function hasOpenDecisionField(decision: string, field: string) {
  return new RegExp(`\\b${field.replaceAll(' ', '\\s+')}\\s*:`, 'i').test(decision);
}

function looksLikeSafeAssumptionOrRisk(decision: string) {
  return (
    /\bconfirm only if\b/i.test(decision) ||
    /\bdefault assumed\b/i.test(decision) ||
    /\bsafe assumption\b/i.test(decision) ||
    /\bwatch\b|\brisk\b/i.test(decision) ||
    /\bwhether\b.*\b(or simply|or only|can be|could be|should simply)\b/i.test(decision)
  );
}

function namesTaskScopedBlocker(decision: string) {
  return /\bblocks?\s+T\d[\w-]*\b/i.test(decision) || /\bbefore\s+T\d[\w-]*\b/i.test(decision);
}

export function openDecisionHygiene(taskPlan: TaskPlan) {
  for (const [index, decision] of taskPlan.open_decisions.entries()) {
    const missingFields = openDecisionRequiredFields.filter((field) => !hasOpenDecisionField(decision, field));
    if (missingFields.length) {
      return {
        passed: false,
        reason: `open_decisions[${index}] is not decision-shaped; include Topic, Why it matters, Options considered, and Follow-up impact.`,
      };
    }

    if (looksLikeSafeAssumptionOrRisk(decision) && !namesTaskScopedBlocker(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] appears to be a safe assumption or risk, not a blocker; move it to readout.safe_assumptions or taskPlan.risks.`,
      };
    }

    if (!/\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible)\b/i.test(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] does not explain what implementation work it blocks.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

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

function looksLikeRepoPathReference(surface: string) {
  const path = normalizeDeliveryPathReference(surface);
  if (!path || /\s/.test(path)) return false;
  if (knownRootPathSurfaces.has(path)) return true;
  if (path.includes('/')) return true;
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(path);
}

function ownedSurfaceReferenceIsConcrete(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:\s*\S/i.test(normalized)) return true;
  return looksLikeRepoPathReference(normalized);
}

function ownedSurfaceReferenceIsWildcard(surface: string) {
  const normalized = normalizeDeliveryPathReference(surface);
  if (/^unknown:/i.test(normalized)) return false;
  return /[*?]/.test(normalized);
}

export function ownedSurfaceHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    for (const surface of task.owned_surfaces) {
      if (ownedSurfaceReferenceIsWildcard(surface)) {
        return {
          passed: false,
          reason: `${task.id} owned_surfaces contains wildcard surface "${surface}". Enumerate concrete file paths so missing files, boundaries, and handoffs can be verified deterministically; use "unknown: <why>" only when a path is genuinely unknowable.`,
        };
      }
      if (ownedSurfaceReferenceIsConcrete(surface)) continue;
      return {
        passed: false,
        reason: `${task.id} owned_surfaces contains conceptual surface "${surface}". Use concrete repo paths like wrangler.toml, src/index.ts, public/settings.html, migrations/0001_schema.sql, or "unknown: <reason>".`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function normalizedOwnedSurfaces(task: Task) {
  return task.owned_surfaces.map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

function ownsExactSurface(task: Task, path: string) {
  return normalizedOwnedSurfaces(task).includes(path);
}

function taskOwnsAnyExactSurface(task: Task, paths: readonly string[]) {
  return paths.some((path) => ownsExactSurface(task, path));
}

function ownsPackageScaffold(task: Task) {
  return ownsExactSurface(task, 'package.json') && ownsExactSurface(task, 'tsconfig.json');
}

function ownsTypeScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) => surface === 'src/**' || (surface.startsWith('src/') && /\.(?:ts|mts|cts)$/.test(surface)),
  );
}

function ownsWorkerRuntimeSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'wrangler.toml' ||
      surface === 'wrangler.json' ||
      surface === 'wrangler.jsonc' ||
      surface === 'src/index.ts' ||
      surface === 'src/env.ts' ||
      surface === 'src/**' ||
      surface.startsWith('src/') ||
      surface.startsWith('public/') ||
      surface.startsWith('migrations/'),
  );
}

export function normalizeTaskPlanScaffoldDependencies(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  if (existsSync(join(repoPath, 'package.json'))) return taskPlan;
  if (!taskPlan.tasks.some(ownsWorkerRuntimeSurface)) return taskPlan;

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find((task) => ownsPackageScaffold(task) && ownsTypeScriptInputSurface(task));
  if (!scaffoldRootTask) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (task.id === scaffoldRootTask.id || task.depends_on.length > 0 || !ownsWorkerRuntimeSurface(task) || ownsPackageScaffold(task)) {
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

function taskDependsOn(taskPlan: TaskPlan, taskId: string, dependencyId: string, seen = new Set<string>()): boolean {
  if (taskId === dependencyId) return true;
  if (seen.has(taskId)) return false;
  seen.add(taskId);

  const task = taskPlan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return false;
  if (task.depends_on.includes(dependencyId)) return true;
  return task.depends_on.some((parentId) => taskDependsOn(taskPlan, parentId, dependencyId, seen));
}

function taskCanSafelyDependOn(taskPlan: TaskPlan, taskId: string, dependencyId: string) {
  return taskId !== dependencyId && !taskDependsOn(taskPlan, dependencyId, taskId);
}

const profileContractProducerSurfaces = ['src/validation.ts', 'src/domain/profile.ts', 'src/domain/profiles.ts'];
const profileContractConsumerSurfaces = ['migrations/0001_schema.sql', 'src/storage/profiles.ts', 'src/routes/profiles.ts'];

function profileContractProducerTask(taskPlan: TaskPlan) {
  return taskPlan.tasks.find((task) => taskOwnsAnyExactSurface(task, profileContractProducerSurfaces));
}

function profileContractConsumerTasks(taskPlan: TaskPlan) {
  return taskPlan.tasks.filter((task) => taskOwnsAnyExactSurface(task, profileContractConsumerSurfaces));
}

export function normalizeTaskPlanProfileContractDependencies(taskPlan: TaskPlan): TaskPlan {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (!profileContractConsumerTasks(taskPlan).some((consumer) => consumer.id === task.id)) return task;
    if (taskDependsOn(taskPlan, task.id, producer.id)) return task;
    if (!taskCanSafelyDependOn(taskPlan, task.id, producer.id)) return task;

    changed = true;
    return {
      ...task,
      depends_on: [...task.depends_on, producer.id],
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

export function profileContractDependencyHygiene(taskPlan: TaskPlan) {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return { passed: true, reason: 'ok' };

  for (const task of profileContractConsumerTasks(taskPlan)) {
    if (taskDependsOn(taskPlan, task.id, producer.id)) continue;
    return {
      passed: false,
      reason: `${task.id} owns a profile contract consumer surface but does not depend_on ${producer.id}. Schema, storage, and profile routes must run after the validation/domain contract so profile kind values stay aligned.`,
    };
  }

  return { passed: true, reason: 'ok' };
}

function taskOwnedBoundaryPaths(task: Task) {
  return normalizedOwnedSurfaces(task).map(concreteOwnedSurfacePath).filter((path): path is string => Boolean(path));
}

function taskOwnsStatePersistenceSurface(task?: Task) {
  if (!task) return true;
  return taskOwnedBoundaryPaths(task).some(
    (path) =>
      path.startsWith('migrations/') ||
      path.startsWith('src/storage/') ||
      path.startsWith('src/workflows/') ||
      /\bdurable|do-state|state-store\b/i.test(path),
  );
}

export function taskOwnedSurfaceRoleHygiene(taskPlan: TaskPlan) {
  for (const task of taskPlan.tasks) {
    const paths = taskOwnedBoundaryPaths(task);
    if (!paths.length) continue;

    const ownership = fileOwnership({ role: task.owner, paths });
    if (!ownership.passed) {
      return {
        passed: false,
        reason: `${task.id} owner ${task.owner} cannot own one or more surfaces: ${ownership.reason}`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function designerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'designer', paths: [path] }).passed;
}

function engineerCanOwnSurface(path: string) {
  return fileOwnership({ role: 'engineer', paths: [path] }).passed;
}

export function normalizeTaskPlanRoleBoundaries(taskPlan: TaskPlan): TaskPlan {
  const designerOwnedPaths = new Set(
    taskPlan.tasks
      .filter((task) => task.owner === 'designer')
      .flatMap(taskOwnedBoundaryPaths),
  );

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (task.owner !== 'engineer') return task;

    const misplacedPaths = new Set(
      taskOwnedBoundaryPaths(task).filter(
        (path) => !engineerCanOwnSurface(path) && designerCanOwnSurface(path) && designerOwnedPaths.has(path),
      ),
    );
    if (!misplacedPaths.size) return task;

    const owned_surfaces = task.owned_surfaces.filter((surface) => {
      const path = concreteOwnedSurfacePath(surface);
      return !path || !misplacedPaths.has(path);
    });
    if (!owned_surfaces.length) return task;

    const acceptance_criteria = task.acceptance_criteria.filter(
      (criterion) => !Array.from(misplacedPaths).some((path) => criterion.includes(path)),
    );

    changed = true;
    return {
      ...task,
      owned_surfaces,
      acceptance_criteria: acceptance_criteria.length ? acceptance_criteria : task.acceptance_criteria,
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

const maxImplementationOwnedSurfacesPerTask = 2;
const minImplementationOwnedSurfacesToSplit = 3;

function splittableImplementationSurfacePath(surface: string) {
  const path = concreteOwnedSurfacePath(surface);
  if (!path) return undefined;
  if (path === 'src/index.ts') return undefined;
  if (path === 'package.json' || path === 'tsconfig.json' || path === 'wrangler.toml') return undefined;
  if (path.startsWith('migrations/')) return undefined;
  if (path.startsWith('src/') && /\.[cm]?[jt]s$/.test(path)) return path;
  return undefined;
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function taskIsLargeImplementationTask(task: Task) {
  const surfaces = task.owned_surfaces.map(splittableImplementationSurfacePath);
  return (
    task.owner === 'engineer' &&
    surfaces.length >= minImplementationOwnedSurfacesToSplit &&
    surfaces.every(Boolean)
  );
}

function implementationSliceAcceptanceCriteria(task: Task, surfaces: string[], sliceNumber: number, sliceCount: number) {
  const paths = surfaces.map(
    (surface) => splittableImplementationSurfacePath(surface) ?? normalizeDeliveryPathReference(surface),
  );
  return [
    `Implement delivery slice ${sliceNumber}/${sliceCount}: ${paths.join(', ')}.`,
    `Replace any preflight stubs for this slice with real implementation code before returning.`,
    `Keep this slice compatible with previously completed delivery slices and npm run typecheck.`,
    ...task.acceptance_criteria.filter((criterion) => paths.some((path) => criterion.includes(path))),
  ];
}

function splitLargeImplementationTask(task: Task) {
  if (!taskIsLargeImplementationTask(task)) return [task];

  const chunks = chunkItems(task.owned_surfaces, maxImplementationOwnedSurfacesPerTask);
  return chunks.map((surfaces, index) => {
    const sliceNumber = index + 1;
    const previousSliceId = index === 1 ? task.id : `${task.id}-part-${index}`;
    return {
      ...task,
      id: index === 0 ? task.id : `${task.id}-part-${sliceNumber}`,
      deliverable: `${task.deliverable} (delivery slice ${sliceNumber}/${chunks.length})`,
      depends_on: index === 0 ? task.depends_on : [previousSliceId],
      acceptance_criteria: implementationSliceAcceptanceCriteria(task, surfaces, sliceNumber, chunks.length),
      owned_surfaces: surfaces,
    };
  });
}

export function normalizeTaskPlanLargeStorageTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitLargeImplementationTask(task);
    expandedTasks.push(...slices);
    if (slices.length > 1) {
      changed = true;
      splitLastTaskId.set(task.id, slices[slices.length - 1].id);
      for (const slice of slices) splitTaskIds.add(slice.id);
    }
  }

  if (!changed) return taskPlan;

  const tasks = expandedTasks.map((task) => {
    if (splitTaskIds.has(task.id)) return task;

    const depends_on = Array.from(new Set(task.depends_on.map((dependency) => splitLastTaskId.get(dependency) ?? dependency)));
    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { ...taskPlan, tasks };
}

export function projectScaffoldHygiene(repoPath: string, taskPlan: TaskPlan) {
  if (existsSync(join(repoPath, 'package.json'))) return { passed: true, reason: 'ok' };

  const plansRuntimeWork = taskPlan.tasks.some(ownsWorkerRuntimeSurface);
  if (!plansRuntimeWork) return { passed: true, reason: 'ok' };

  const rootTasks = taskPlan.tasks.filter((task) => task.depends_on.length === 0);
  const scaffoldRootTask = rootTasks.find(ownsPackageScaffold);
  if (!scaffoldRootTask) {
    return {
      passed: false,
      reason:
        'Target repo has no package.json. The task plan needs a root scaffold task that owns package.json and tsconfig.json before Worker runtime files so automated verification can run.',
    };
  }

  if (!ownsTypeScriptInputSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns package.json and tsconfig.json but no TypeScript source input. Bare Worker scaffolds need an owned src/*.ts surface such as src/index.ts or src/env.ts so npm run typecheck can pass before later tasks.`,
    };
  }

  const unscaffoldedRootRuntimeTask = rootTasks.find((task) => ownsWorkerRuntimeSurface(task) && !ownsPackageScaffold(task));
  if (unscaffoldedRootRuntimeTask) {
    return {
      passed: false,
      reason: `${unscaffoldedRootRuntimeTask.id} owns Worker/runtime surfaces before the package scaffold. Make it depend_on ${scaffoldRootTask.id}, or include package.json and tsconfig.json in the same root scaffold task.`,
    };
  }

  return { passed: true, reason: 'ok' };
}

function normalizeTaskPlanForDelivery(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  return normalizeTaskPlanLargeStorageTasks(
    normalizeTaskPlanRoleBoundaries(
      normalizeTaskPlanProfileContractDependencies(normalizeTaskPlanScaffoldDependencies(repoPath, taskPlan)),
    ),
  );
}

const taskPlanDeterministicResults = ({
  repoPath,
  taskPlan,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
}): DeterministicGateResult[] => [
  { id: 'tasks_structurally_complete', check: 'plan_schema_complete', ...planSchemaComplete(taskPlan) },
  { id: 'no_circular_dependencies', check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(taskPlan) },
  { id: 'open_decisions_hygiene', check: 'open_decision_hygiene', ...openDecisionHygiene(taskPlan) },
  { id: 'owned_surfaces_concrete', check: 'owned_surface_hygiene', ...ownedSurfaceHygiene(taskPlan) },
  { id: 'owned_surfaces_match_roles', check: 'task_owned_surfaces_in_role_boundary', ...taskOwnedSurfaceRoleHygiene(taskPlan) },
  { id: 'root_project_scaffolded', check: 'project_scaffold_hygiene', ...projectScaffoldHygiene(repoPath, taskPlan) },
  {
    id: 'profile_contract_dependency_order',
    check: 'profile_contract_dependency_order',
    ...profileContractDependencyHygiene(taskPlan),
  },
];

function topoOrderTasks(tasks: Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (byId.has(dependency)) indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0);
  const ordered: Task[] = [];
  while (queue.length) {
    const task = queue.shift();
    if (!task) continue;
    ordered.push(task);
    for (const candidate of tasks) {
      if (candidate.depends_on.includes(task.id)) {
        indegree.set(candidate.id, (indegree.get(candidate.id) ?? 0) - 1);
        if (indegree.get(candidate.id) === 0) queue.push(candidate);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error('task dependency graph is cyclic or incomplete');
  }

  return ordered;
}

const buildRoleForTask = (task: Task) => (task.owner === 'designer' ? 'designer' : 'engineer') as 'designer' | 'engineer';

const taskStatusSummary = (state: Record<string, 'complete' | 'stuck' | 'blocked'>) =>
  Object.entries(state).map(([id, status]) => `${id}:${status}`);

export const hasExecutableRootTask = (taskPlan: TaskPlan) =>
  taskPlan.tasks.some((task) => task.depends_on.length === 0 && task.acceptance_criteria.length && task.owned_surfaces.length);

export const shouldSuspendForPlannerQuestions = (readout: z.infer<typeof readoutSchema>, taskPlan: TaskPlan) =>
  readout.blocking_ambiguities.length > 0 && !hasExecutableRootTask(taskPlan);

function weakDimensionIsNonActionableForTask(
  dimension: AggregatedJudgment['dimensions_scored'][number],
  task?: Task,
) {
  if (dimension.id === 'implementation_note_quality') return true;
  if (dimension.id !== 'state_explicitness') return false;
  if (taskOwnsStatePersistenceSurface(task)) return false;
  return /\b(database|db|d1|sql|schema|table|check constraints?|indexes?|indices)\b/i.test(dimension.evidence);
}

export function implementationWeakDimensionRemediation(judgment: AggregatedJudgment, task?: Task) {
  return judgment.dimensions_scored
    .filter((dimension) => dimension.score <= 3)
    .filter((dimension) => !weakDimensionIsNonActionableForTask(dimension, task))
    .map(
      (dimension) =>
        `DIMENSION ${dimension.id} scored ${dimension.score}/5. Improve this before continuing: ${compactDiagnostic(
          dimension.evidence,
          500,
        )}`,
    );
}

function implementationFindingSteps(taskId: string, judgment: AggregatedJudgment, task?: Task) {
  const remediation = [...judgment.remediation, ...implementationWeakDimensionRemediation(judgment, task)];
  return remediation.length ? remediation : [`${taskId} did not produce a passing implementation judgment`];
}

export function shouldProceedAfterNonActionableImplementationJudgment({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed) return false;
  if (judgment.gates_failed.length || judgment.dimensions_missing.length || judgment.remediation.length) return false;
  if (implementationWeakDimensionRemediation(judgment, task).length) return false;
  if (!deterministicResults.every((result) => result.passed)) return false;
  if (!note.verification.performed.length) return false;
  if (note.verification.missing.some((item) => /\bfailed:/i.test(item))) return false;
  return true;
}

export function implementationJudgmentCanComplete({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed && !judgment.gates_failed.length && !judgment.dimensions_missing.length) return true;
  return shouldProceedAfterNonActionableImplementationJudgment({ judgment, deterministicResults, note, task });
}

function repoFileContents(repoPath: string, paths: string[]) {
  return paths
    .map((path) => {
      const normalizedPath = normalizeDeliveryPathReference(path);
      const fullPath = isAbsolute(normalizedPath) ? normalizedPath : join(resolve(repoPath), normalizedPath);
      if (!existsSync(fullPath)) return undefined;
      return {
        path: normalizedPath,
        content: readFileSync(fullPath, 'utf8'),
      };
    })
    .filter((file): file is { path: string; content: string } => Boolean(file));
}

function concreteTaskSurfacePaths(task: Task) {
  return normalizedOwnedSurfaces(task)
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path) && !/^unknown:/i.test(path));
}

export function directDependencySurfacePaths(taskPlan: TaskPlan, task: Task) {
  const byId = new Map(taskPlan.tasks.map((candidate) => [candidate.id, candidate]));
  const paths = task.depends_on.flatMap((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return dependency ? concreteTaskSurfacePaths(dependency) : [];
  });
  return Array.from(new Set(paths.filter((path) => !taskOwnedBoundaryPaths(task).includes(path))));
}

function focusedRepairContextPaths(taskPlan: TaskPlan, task: Task, boundarySurfaces: string[]) {
  const boundaryPaths = boundarySurfaces
    .filter((surface) => !surface.includes('*'))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path));
  const dependencyPaths = directDependencySurfacePaths(taskPlan, task).filter(
    (path) => path.startsWith('src/') || path.startsWith('migrations/'),
  );
  return Array.from(new Set([...boundaryPaths, ...dependencyPaths]));
}

const implementationWriteTools = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'auto_repair',
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
]);

function responseText(response: unknown) {
  if (!response || typeof response !== 'object') return undefined;
  const text = (response as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function knownSecretValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) && typeof value === 'string')
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value && value.length >= 8));
}

function redactSecretsFromText(text: string) {
  return knownSecretValues().reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
}

function redactTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsFromText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTraceValue(item)]));
}

function serializeAgentResponse(response: unknown) {
  if (!response || typeof response !== 'object') return redactTraceValue(response);
  const record = response as Record<string, unknown>;
  return redactTraceValue({
    text: record.text,
    object: record.object,
    finishReason: record.finishReason,
    usage: record.usage,
    warnings: record.warnings,
  });
}

async function writeStageTraceArtifact({
  repoPath,
  mastra,
  artifactType,
  artifactPath,
  trace,
}: {
  repoPath: string;
  mastra: any;
  artifactType: string;
  artifactPath: string;
  trace: unknown;
}) {
  writeDeliveryArtifact({
    repoPath,
    artifactPath,
    artifact: redactTraceValue(trace),
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: artifactType,
    path: artifactPath,
    mastra,
  });
  return artifactPath;
}

function existingOwnedFiles(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task).filter((surface) => {
    if (surface.includes('*')) return false;
    const path = concreteOwnedSurfacePath(surface);
    return path ? existsSync(join(resolve(repoPath), path)) : false;
  });
}

function concreteOwnedSurfacePath(surface: string) {
  const trimmed = normalizeDeliveryPathReference(surface);
  if (!trimmed || trimmed.includes('*') || /^unknown\b/i.test(trimmed)) return undefined;
  if (!looksLikeRepoPathReference(trimmed)) return undefined;
  return trimmed;
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

  const weeklyPath = join(resolve(repoPath), 'src/workflows/weekly.ts');
  if (!existsSync(weeklyPath)) return [];

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
        `Workflow step ${step} is not called from src/workflows/weekly.ts; the step can pass in isolation while the Cloudflare Workflow still runs the old pass-through stub.`,
      ];
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

  const indexPath = join(resolve(repoPath), 'src/index.ts');
  const routerPath = join(resolve(repoPath), 'src/http/router.ts');
  if (!existsSync(indexPath) || !existsSync(routerPath)) return [];

  const indexSource = readFileSync(indexPath, 'utf8');
  if (!/\brouteRequest\s*\(/.test(indexSource)) return [];

  return routeSurfaces.flatMap((surface) => {
    const slug = surface.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '');
    if (!slug) return [];

    const routeImportPattern = new RegExp(
      `\\bfrom\\s+['"]\\.\\/routes\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    if (!routeImportPattern.test(indexSource)) return [];

    return [
      `Route surface ${surface} is imported directly from src/index.ts while the existing routeRequest router is present; register it through the router/barrel/middleware path instead of dispatching before routeRequest.`,
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
  const source = repoTextIfExists(repoPath, 'migrations/0001_schema.sql');
  if (!source) return [];
  const table = source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+profile_artifacts\s*\([\s\S]*?\n\);/i)?.[0] ?? source;
  const match = table.match(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i);
  return match ? stringLiteralsFromText(match[1]) : [];
}

function missingProfileKinds(expected: string[], actual: string[]) {
  if (!expected.length || !actual.length) return [];
  return expected.filter((kind) => !actual.includes(kind));
}

function taskOwnsProfileMigration(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => concreteOwnedSurfacePath(surface) === 'migrations/0001_schema.sql');
}

function taskOwnsProfileStorage(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => concreteOwnedSurfacePath(surface) === 'src/storage/profiles.ts');
}

export function profileKindContractGaps(repoPath: string, task: Task) {
  const expected = validationProfileKinds(repoPath);
  if (!expected.length) return [];

  const gaps: string[] = [];
  if (taskOwnsProfileMigration(task)) {
    const missing = missingProfileKinds(expected, migrationProfileKinds(repoPath));
    if (missing.length) {
      gaps.push(
        `migrations/0001_schema.sql profile_artifacts.kind omits profile contract kind(s): ${missing.join(', ')}. Keep schema kind values aligned with PROFILE_KINDS or ProfileKind from the validation/domain profile contract.`,
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

function taskBoundaryCanConfigureWorkersAi(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some((path) => ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 'src/index.ts'].includes(path));
}

function repoSourceUsesWorkersAi(repoPath: string) {
  const sourceRoot = join(resolve(repoPath), 'src');
  return [
    'env.AI',
    'WorkersAiClient',
    'createAiClient',
    "from './ai/client'",
    "from '../ai/client'",
    "from '../../ai/client'",
  ].some((needle) => sourceTreeContainsText(sourceRoot, needle, { count: 0 }));
}

function wranglerTomlHasWorkersAiBinding(text: string) {
  let inAiSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    const line = rawLine.replace(/\s+#.*$/, '');
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inAiSection = section[1] === 'ai';
      continue;
    }
    if (inAiSection && /^\s*binding\s*=\s*["']AI["']\s*$/.test(line)) return true;
  }
  return false;
}

function wranglerJsonHasWorkersAiBinding(text: string) {
  const withoutLineComments = text.replace(/(^|[^:])\/\/.*$/gm, '$1');
  try {
    const parsed = JSON.parse(withoutLineComments) as { ai?: { binding?: unknown } };
    if (parsed.ai?.binding === 'AI') return true;
  } catch {
    // Fall back to a narrow regex for JSONC with trailing commas.
  }
  return /"ai"\s*:\s*\{[\s\S]*?"binding"\s*:\s*"AI"/.test(text);
}

export function wranglerConfigHasWorkersAiBinding(repoPath: string) {
  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) return false;
  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return wranglerTomlHasWorkersAiBinding(text);
  return wranglerJsonHasWorkersAiBinding(text);
}

function workerEnvMarksAiOptional(repoPath: string) {
  const indexPath = join(resolve(repoPath), 'src/index.ts');
  if (!existsSync(indexPath)) return false;
  return /\bAI\?\s*:\s*Ai\b/.test(readFileSync(indexPath, 'utf8'));
}

export function workersAiBindingGaps(repoPath: string, task?: Task) {
  if (!repoSourceUsesWorkersAi(repoPath)) return [];
  if (task && !taskBoundaryCanConfigureWorkersAi(repoPath, task)) return [];

  const gaps: string[] = [];
  if (!wranglerConfigHasWorkersAiBinding(repoPath)) {
    gaps.push('Workers AI source is present, but the Wrangler config does not contain an active [ai] binding = "AI" section.');
  }
  if (workerEnvMarksAiOptional(repoPath)) {
    gaps.push('Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.');
  }
  return gaps;
}

export function missingOwnedSurfacePaths(repoPath: string, task: Task) {
  return effectiveOwnedSurfaces(task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => !existsSync(join(resolve(repoPath), path)));
}

const deliveryPreflightStubMarker = 'Delivery preflight stub';

function compileSafeStubForSurface(path: string) {
  if (/\.(?:ts|mts|cts)$/.test(path)) {
    return [
      `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.`,
      'export {};',
      '',
    ].join('\n');
  }
  if (/\.(?:js|mjs|cjs)$/.test(path)) {
    return `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.\n`;
  }
  if (/\.json$/.test(path)) return '{}\n';
  if (/\.(?:sql)$/.test(path)) return `-- ${deliveryPreflightStubMarker}. The implementation agent should replace this with task SQL.\n`;
  if (/\.(?:toml|ya?ml)$/.test(path)) return `# ${deliveryPreflightStubMarker}. The implementation agent should replace this with task config.\n`;
  if (/\.css$/.test(path)) return `/* ${deliveryPreflightStubMarker}. The implementation agent should replace this with task styles. */\n`;
  if (/\.html?$/.test(path)) return `<!doctype html>\n<!-- ${deliveryPreflightStubMarker}. The implementation agent should replace this with task markup. -->\n`;
  return '';
}

export async function createMissingOwnedSurfaceStubs({
  repoPath,
  task,
  stage,
  mastra,
}: {
  repoPath: string;
  task: Task;
  stage: string;
  mastra?: any;
}) {
  const created: string[] = [];
  for (const path of missingOwnedSurfacePaths(repoPath, task)) {
    const fullPath = join(resolve(repoPath), path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, compileSafeStubForSurface(path));
    created.push(path);
  }

  if (created.length) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'preflight_stub_created',
        stage,
        task: task.id,
        paths: created,
      },
    }).catch(() => undefined);
  }

  return created;
}

export function unreplacedPreflightStubPaths(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .filter((path) => {
      const fullPath = join(resolve(repoPath), path);
      if (!existsSync(fullPath)) return false;
      return readFileSync(fullPath, 'utf8').includes(deliveryPreflightStubMarker);
    });
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
    const barrel = `${directory}/index.ts`;
    if (existsSync(join(resolve(repoPath), barrel))) surfaces.add(barrel);

    if (directory === 'src/routes' && existsSync(join(resolve(repoPath), 'src/index.ts'))) {
      surfaces.add('src/index.ts');
    }

    if (directory === 'src/workflows/steps' && existsSync(join(resolve(repoPath), 'src/workflows/weekly.ts'))) {
      surfaces.add('src/workflows/weekly.ts');
    }
  }

  return [...surfaces];
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

function verificationFailurePaths(failure: string) {
  const paths = new Set<string>();
  const pathPattern =
    /(?:^|\n)([^\s:()]+(?:\/[^\s:()]+)*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|html?))(?::\d+(?::\d+)?|\(\d+,\d+\))/g;
  for (const match of failure.matchAll(pathPattern)) {
    const path = normalizeDeliveryPathReference(match[1]);
    if (!path.startsWith('.delivery/') && !path.startsWith('node_modules/')) paths.add(path);
  }
  return [...paths];
}

export function staleDownstreamVerificationSurfacePaths({
  repoPath,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const orderedTasks = topoOrderTasks(taskPlan.tasks);
  const protectedSurfaces = orderedTasks
    .slice(0, currentTaskIndex + 1)
    .flatMap((task) => taskBoundarySurfaces(repoPath, task))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path));
  const downstreamTasks = orderedTasks.slice(currentTaskIndex + 1);

  return verificationFailurePaths(failure).filter((path) => {
    if (!existsSync(join(resolve(repoPath), path))) return false;
    if (matchesAny(path, protectedSurfaces)) return false;

    return downstreamTasks.some((task) => {
      if (reusableImplementationArtifactForTask(repoPath, task)) return false;
      return matchesAny(path, taskBoundarySurfaces(repoPath, task));
    });
  });
}

export function outOfPlanVerificationFailurePaths({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  failure: string;
}) {
  const allPlannedSurfaces = taskPlan.tasks
    .flatMap((task) => taskBoundarySurfaces(repoPath, task))
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path));

  return verificationFailurePaths(failure).filter((path) => {
    if (!existsSync(join(resolve(repoPath), path))) return false;
    return !matchesAny(path, allPlannedSurfaces);
  });
}

function staleWorkspaceVerificationRemediation({
  repoPath,
  taskPlan,
  failure,
}: {
  repoPath: string;
  taskPlan?: TaskPlan;
  failure: string;
}) {
  if (!taskPlan) return undefined;
  const paths = outOfPlanVerificationFailurePaths({ repoPath, taskPlan, failure });
  if (!paths.length) return undefined;

  return `STALE_WORKSPACE_VERIFICATION: repo-wide verification failed in existing file(s) outside the current task plan: ${paths.join(', ')}. Start from a clean project baseline, archive stale generated files, or revise the plan so those files are owned before retrying. Original failure: ${compactDiagnostic(failure, 500)}`;
}

export async function repairStaleDownstreamVerificationSurfaces({
  repoPath,
  mastra,
  stage,
  taskPlan,
  currentTaskIndex,
  failure,
}: {
  repoPath: string;
  mastra?: any;
  stage: string;
  taskPlan: TaskPlan;
  currentTaskIndex: number;
  failure: string;
}) {
  const paths = staleDownstreamVerificationSurfacePaths({
    repoPath,
    taskPlan,
    currentTaskIndex,
    failure,
  });
  if (!paths.length) return false;

  for (const path of paths) {
    writeFileSync(join(resolve(repoPath), path), compileSafeStubForSurface(path));
  }

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths,
      output_summary:
        'Reset stale downstream task surfaces to compile-safe preflight stubs after repo-wide verification failed.',
    },
  }).catch(() => undefined);
  return true;
}

function policyDeniedWriteEvents(events: DeliveryEvent[], stage: string) {
  return stageSlice(events, stage).filter(
    (event) =>
      event.type === 'tool_use' &&
      event.ok === false &&
      /\b(outside this task's owned surfaces|outside .* owned globs|forbidden glob)\b/i.test(String(event.error ?? '')),
  );
}

export function implementationEnginePolicyMismatch({
  repoPath,
  stage,
  role,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  task: Task;
  events: DeliveryEvent[];
}) {
  const taskSurfaces = taskBoundarySurfaces(repoPath, task);
  const mismatchedPaths = policyDeniedWriteEvents(events, stage)
    .flatMap((event) => event.paths ?? [])
    .filter((path) => {
      const clean = normalizeDeliveryPathReference(path);
      if (!clean || clean.startsWith('.delivery/')) return false;
      return fileOwnership({ role, paths: [clean] }).passed && matchesAny(clean, taskSurfaces);
    });

  const uniquePaths = Array.from(new Set(mismatchedPaths.map(normalizeDeliveryPathReference)));
  if (!uniquePaths.length) return [];

  return [
    `ENGINE_POLICY_MISMATCH ${task.id}: workspace policy rejected path(s) that normalize inside ${role}/${task.id} boundaries: ${uniquePaths.join(', ')}. This is a delivery engine boundary bug; do not spend model retries on it.`,
  ];
}

function taskOwnsPackageManifest(task: Task) {
  return effectiveOwnedSurfaces(task).some((surface) => {
    const path = concreteOwnedSurfacePath(surface);
    return path === 'package.json' || path === 'package-lock.json';
  });
}

function packageDependencyNames(repoPath: string) {
  const parsed = readJsonArtifact(repoPath, 'package.json');
  if (!parsed || typeof parsed !== 'object') return [];

  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = (parsed as Record<string, unknown>)[key];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const name of Object.keys(bucket)) names.add(name);
  }

  return [...names].sort();
}

function remediationHasVerificationFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(verification_passed|build_verification_passed|npm run|typecheck|tsc|TS\d+|Cannot find module)\b/i.test(item),
  );
}

function remediationHasStaleWorkspaceVerificationFailure(remediation: string[]) {
  return remediation.some((item) => /\bSTALE_WORKSPACE_VERIFICATION\b/i.test(item));
}

function remediationHasImplementationJudgmentFailure(remediation: string[]) {
  return remediation.some((item) => /\b(GATE|DIMENSION|JUDGE|implementation judgment)\b/i.test(item));
}

function remediationHasJudgeTimeout(remediation: string[]) {
  return remediation.some((item) => /\bJUDGE_TIMEOUT\b|judge.+timed out/i.test(item));
}

function remediationHasMissingSurfaceFailure(remediation: string[]) {
  return remediation.some((item) => /\bowned_surfaces_present\b.*\bmissing owned surfaces\b/i.test(item));
}

function remediationHasUnreplacedPreflightStubFailure(remediation: string[]) {
  return remediation.some((item) => /\b(preflight_stubs_replaced|preflight stubs remain)\b/i.test(item));
}

function remediationHasPolicyBoundaryFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(file_ownership|write_paths_in_boundary|owned globs|forbidden glob|outside this task)\b/i.test(
      item,
    ),
  );
}

export function implementationFailureClass(remediation: string[]) {
  if (remediationHasMissingSurfaceFailure(remediation)) return 'missing_surface' as const;
  if (remediationHasUnreplacedPreflightStubFailure(remediation)) return 'preflight_stub' as const;
  if (remediationHasStaleWorkspaceVerificationFailure(remediation)) return 'stale_workspace_verification' as const;
  if (remediationHasVerificationFailure(remediation)) return 'code_verification' as const;
  if (remediationHasPolicyBoundaryFailure(remediation)) return 'policy_boundary' as const;
  if (remediationHasJudgeTimeout(remediation)) return 'judge_timeout' as const;
  if (remediationHasImplementationJudgmentFailure(remediation)) return 'judge_quality' as const;
  if (remediation.some((item) => /\b(no tool calls|without making a tool call|made no tool calls)\b/i.test(item))) {
    return 'model_no_action' as const;
  }
  if (remediation.some((item) => /timed out/i.test(item))) return 'model_timeout' as const;
  return 'unknown' as const;
}

export function canSalvageTimedOutBuildAttempt({
  stageHadToolUse,
  missingSurfaces,
  unreplacedStubs,
}: {
  stageHadToolUse: boolean;
  missingSurfaces: string[];
  unreplacedStubs: string[];
}) {
  return stageHadToolUse && missingSurfaces.length === 0 && unreplacedStubs.length === 0;
}

export function implementationRetryMode({
  remediation,
  missingSurfaces,
  unreplacedStubs = [],
}: {
  remediation: string[];
  missingSurfaces: string[];
  unreplacedStubs?: string[];
}) {
  const timeoutRecovery = remediation.some((item) => /timed out/i.test(item));
  const failureClass = implementationFailureClass(remediation);
  const noActionRecovery = failureClass === 'model_no_action';
  if (failureClass === 'preflight_stub' || (unreplacedStubs.length && (timeoutRecovery || noActionRecovery))) {
    return 'replace-stubs' as const;
  }
  if ((timeoutRecovery || noActionRecovery || failureClass === 'missing_surface') && missingSurfaces.length) {
    return 'write-first' as const;
  }
  if (
    timeoutRecovery ||
    noActionRecovery ||
    failureClass === 'policy_boundary' ||
    failureClass === 'judge_timeout' ||
    remediationHasVerificationFailure(remediation) ||
    remediationHasImplementationJudgmentFailure(remediation)
  ) {
    return 'focused-repair' as const;
  }
  return 'normal' as const;
}

export function implementationToolChoiceForRetryMode(retryMode: ReturnType<typeof implementationRetryMode>) {
  return retryMode === 'write-first' || retryMode === 'replace-stubs' || retryMode === 'focused-repair'
    ? 'required'
    : 'auto';
}

function judgeRepairAlreadyAttempted(remediation: string[]) {
  return remediation.some((item) => /^JUDGE repair attempt:/i.test(item));
}

function implementationJudgeRepairRemediation(judgmentPath: string, remediation: string[]) {
  return [`JUDGE repair attempt: fix failed implementation judgment ${judgmentPath}`, ...remediation];
}

function implementationJudgeTimeoutRemediation(taskId: string, attemptNumber: number, timeoutMs: number) {
  return [
    `JUDGE_TIMEOUT ${taskId}.a${attemptNumber}: implementation judgment timed out after ${timeoutMs}ms. Preserve working code, improve direct evidence or the implementation note if needed, and retry with bounded judgment.`,
  ];
}

export function buildTimeoutRemediation({
  task,
  timeoutMs,
  missingSurfaces,
  repairRecovery,
  noToolCall = false,
  priorRemediation = [],
}: {
  task: Task;
  timeoutMs: number;
  missingSurfaces: string[];
  repairRecovery: boolean;
  noToolCall?: boolean;
  priorRemediation?: string[];
}) {
  if (noToolCall && missingSurfaces.length) {
    return [
      `${task.id} build attempt made no tool calls after ${timeoutMs}ms. Create the missing owned surfaces before any broad investigation: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (noToolCall && repairRecovery) {
    return preservePriorRemediation([
      `${task.id} repair attempt made no tool calls after ${timeoutMs}ms. Make a focused write to the existing boundary surfaces before returning.`,
    ], priorRemediation);
  }

  if (noToolCall) {
    return [
      `${task.id} build attempt made no tool calls after ${timeoutMs}ms. Make a focused write to the boundary surfaces before returning.`,
    ];
  }

  if (missingSurfaces.length) {
    return [
      `${task.id} build attempt timed out after ${timeoutMs}ms. Create the missing owned surfaces before any broad investigation: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (repairRecovery) {
    return preservePriorRemediation([
      `${task.id} repair attempt timed out after ${timeoutMs}ms. Fix the reported repair findings in the existing boundary surfaces before any broad investigation.`,
    ], priorRemediation);
  }

  return [
    `${task.id} build attempt timed out after ${timeoutMs}ms. Edit the boundary surfaces before any broad investigation.`,
  ];
}

function preservePriorRemediation(primary: string[], priorRemediation: string[]) {
  return [...primary, ...priorRemediation.filter((item) => !primary.includes(item))];
}

export function priorStoppedBuildTaskIds({
  taskPlan,
  taskIndex,
  taskStatuses,
}: {
  taskPlan: TaskPlan;
  taskIndex: number;
  taskStatuses: Record<string, { status?: string } | undefined>;
}) {
  return topoOrderTasks(taskPlan.tasks)
    .slice(0, taskIndex)
    .filter((task) => ['stuck', 'blocked'].includes(String(taskStatuses[task.id]?.status)))
    .map((task) => task.id);
}

export function reusableImplementationArtifactForTask(repoPath: string, task: Task) {
  if (process.env.DELIVERY_REUSE_TASK_ARTIFACTS === '0') return undefined;
  if (missingOwnedSurfacePaths(repoPath, task).length) return undefined;
  if (workflowStepIntegrationGaps(repoPath, task).length) return undefined;
  if (workersAiBindingGaps(repoPath, task).length) return undefined;

  const judgmentDir = join(resolve(repoPath), '.delivery/artifacts/judgments');
  if (!existsSync(judgmentDir)) return undefined;

  const prefix = `implementation-${task.id}-a`;
  const candidates = readdirSync(judgmentDir)
    .map((file) => {
      const match = file.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.judgment\\.json$`));
      return match ? { file, attempt: Number(match[1]) } : undefined;
    })
    .filter((candidate): candidate is { file: string; attempt: number } => Boolean(candidate))
    .sort((a, b) => b.attempt - a.attempt);

  for (const candidate of candidates) {
    const judgmentPath = `.delivery/artifacts/judgments/${candidate.file}`;
    const judgment = readJsonArtifact(repoPath, judgmentPath) as Partial<AggregatedJudgment> | undefined;
    if (!judgment?.passed || typeof judgment.overall !== 'number') continue;

    const notePath = `.delivery/artifacts/note-${task.id}.a${candidate.attempt}.json`;
    const note = implementationNoteSchema.safeParse(readJsonArtifact(repoPath, notePath));
    if (!note.success || note.data.task !== task.id) continue;

    const ownership = runDeterministicCheck({
      name: 'file_ownership',
      role: buildRoleForTask(task),
      paths: note.data.files_touched,
    });
    if (!ownership.passed) continue;

    const judgeOutputPath = judgmentPath.replace(/\.judgment\.json$/, '.judge.json');
    return {
      note: note.data,
      notePath,
      judgment,
      judgmentPath,
      judgeOutputPath: existsSync(join(resolve(repoPath), judgeOutputPath)) ? judgeOutputPath : undefined,
      attempt: candidate.attempt,
    };
  }

  return undefined;
}

export function deliveryBuildResumePlan(repoPath: string, taskPlan: TaskPlan) {
  const orderedTasks = topoOrderTasks(taskPlan.tasks);
  const reusableTaskIds: string[] = [];
  const reusableSet = new Set<string>();

  for (const task of orderedTasks) {
    if (!task.depends_on.every((dependency) => reusableSet.has(dependency))) break;
    if (!reusableImplementationArtifactForTask(repoPath, task)) break;
    reusableTaskIds.push(task.id);
    reusableSet.add(task.id);
  }

  const nextTask = orderedTasks[reusableTaskIds.length];
  return {
    reusableTaskIds,
    resumeAfterTaskId: reusableTaskIds.at(-1),
    nextTaskId: nextTask?.id,
    totalTasks: orderedTasks.length,
  };
}

function deliveryBuildResumeReason(plan: ReturnType<typeof deliveryBuildResumePlan>) {
  if (!plan.reusableTaskIds.length) return undefined;
  const resumeAfter = plan.resumeAfterTaskId ?? 'none';
  const nextTask = plan.nextTaskId ?? 'release gate';
  return `Resume cursor: ${plan.reusableTaskIds.length}/${plan.totalTasks} implementation task(s) already have passing artifacts; resume after ${resumeAfter}, next ${nextTask}.`;
}

function effectiveOwnedSurfaces(task: Task) {
  const surfaces = new Set(task.owned_surfaces);
  const taskText = [task.deliverable, ...task.acceptance_criteria].join('\n');

  if (/\bsrc\/\s+directories\b|\bproject structure\b|\bsrc\/\s+directories for\b/i.test(taskText)) {
    surfaces.add('src/**');
  }

  return [...surfaces];
}

export function implementationFilesTouched({
  repoPath,
  stage,
  task,
  events,
}: {
  repoPath: string;
  stage: string;
  task: Task;
  events: DeliveryEvent[];
}) {
  const stageEvents = implementationStageEvents(events, stage);
  const written = stageEvents
    .filter((event) => event.ok !== false && implementationWriteTools.has(String(event.tool)))
    .flatMap((event) => event.paths ?? [])
    .filter((path) => path && !path.startsWith('.delivery/'));

  return Array.from(new Set(written.length ? written : existingOwnedFiles(repoPath, task)));
}

function implementationStageEvents(events: DeliveryEvent[], stage: string) {
  const stageEvents: DeliveryEvent[] = [];
  let active = false;

  for (const event of events) {
    if (event.type === 'stage_start' && event.stage === stage) {
      active = true;
      stageEvents.push(event);
      continue;
    }

    if (!active) continue;

    stageEvents.push(event);
    if (event.type === 'stage_end' && event.stage === stage) {
      active = false;
    }
  }

  return stageEvents;
}

function packageScripts(repoPath: string) {
  const parsed = readJsonArtifact(repoPath, 'package.json');
  if (!parsed || typeof parsed !== 'object') return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  return scripts && typeof scripts === 'object' ? (scripts as Record<string, unknown>) : {};
}

function buildVerificationScript(repoPath: string) {
  const scripts = packageScripts(repoPath);
  for (const script of ['typecheck', 'test', 'build']) {
    if (typeof scripts[script] === 'string') return script;
  }
  return undefined;
}

async function ensureNodeDependencies({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  if (!existsSync(join(resolve(repoPath), 'package.json'))) return;
  if (existsSync(join(resolve(repoPath), 'node_modules'))) return;

  const command = 'npm install';
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: 180_000 });
  try {
    const result = await execFileAsync('npm', ['install'], {
      cwd: resolve(repoPath),
      timeout: 180_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: true,
        output_summary: compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500),
      },
    });
  } catch (error) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: false,
        error: commandFailureSummary(error, 1000),
      },
    });
  }
}

async function recordRunCodeStart({
  repoPath,
  mastra,
  stage,
  command,
  timeoutMs,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: string;
  timeoutMs?: number;
}) {
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code_start',
      stage,
      command,
      timeout_ms: timeoutMs,
      output_summary: `Started ${command}.`,
    },
  });
}

async function runBuildVerification({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  allowRepair = true,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  allowRepair?: boolean;
}) {
  const script = buildVerificationScript(repoPath);
  if (!script) {
    return {
      performed: [] as string[],
      missing: ['No package verification script found for this build task.'],
    };
  }

  await ensureNodeDependencies({ repoPath, mastra, stage });

  const command = `npm run ${script}`;
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: 120_000 });
  try {
    const result = await execFileAsync('npm', ['run', script], {
      cwd: resolve(repoPath),
      timeout: 120_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: true,
        output_summary: compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500),
      },
    });
    return {
      performed: [`${command} passed`],
      missing: [] as string[],
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: false,
        error: failure,
      },
    });

    if (allowRepair && (await applyBuildVerificationRepair({ repoPath, mastra, stage, taskPlan, taskIndex, failure }))) {
      return runBuildVerification({ repoPath, mastra, stage, taskPlan, taskIndex, allowRepair: false });
    }

    const staleWorkspaceFailure = staleWorkspaceVerificationRemediation({ repoPath, taskPlan, failure });
    if (staleWorkspaceFailure) {
      return {
        performed: [] as string[],
        missing: [`${command} failed: ${staleWorkspaceFailure}`],
      };
    }

    return {
      performed: [] as string[],
      missing: [`${command} failed: ${commandFailureSummary(error, 600)}`],
    };
  }
}

type ReleaseGateEvidenceCommand = {
  tier: 'smoke' | 'api' | 'e2e' | 'full_matrix';
  command: string;
  executable: string;
  args: string[];
  required: boolean;
  reason: string;
};

type ReleaseGateEvidenceResult = {
  tier: ReleaseGateEvidenceCommand['tier'];
  command: string;
  ok: boolean;
  required: boolean;
  reason: string;
  output_summary?: string;
  error?: string;
  probes?: ReleaseGateHttpProbeResult[];
};

type ReleaseGateEvidence = {
  artifact_type: 'test-evidence';
  stage: string;
  commands: ReleaseGateEvidenceResult[];
  notes: string[];
};

type ReleaseGateProcessCommand = {
  command: string;
  executable: string;
  args: string[];
};

type ReleaseGateHttpProbePlan = {
  method: 'GET' | 'POST';
  path: string;
  expected: string;
  expectedStatus?: number;
  statusBelow?: number;
  jsonContains?: Record<string, string | number | boolean | null>;
  jsonArrayAssertions?: ReleaseGateJsonArrayAssertion[];
  body?: ReleaseGateHttpRequestBody;
  headers?: Record<string, string>;
  reason: string;
};

type ReleaseGateRuntimeProbePlan = {
  tier: 'api';
  command: ReleaseGateProcessCommand;
  probes: ReleaseGateHttpProbePlan[];
  required: boolean;
  reason: string;
};

type ReleaseGateHttpProbeResult = {
  method: ReleaseGateHttpProbePlan['method'];
  path: string;
  url: string;
  expected: string;
  ok: boolean;
  status?: number;
  response_summary?: string;
  error?: string;
};

type ReleaseGateHttpRequestBody =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string; contentType?: string }
  | {
      type: 'multipart-profile';
      kind: 'audience_segments' | 'voice_profile';
      filename: string;
      markdown: string;
      setActive?: boolean;
    };

type ReleaseGateJsonArrayAssertion =
  | { type: 'minLength'; min: number }
  | { type: 'containsObject'; where: Record<string, string | number | boolean | null> }
  | { type: 'countObjects'; where: Record<string, string | number | boolean | null>; count: number };

function firstTomlStringValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text);
  return match?.[1];
}

function releaseGateWorkerConfigPath(repoPath: string) {
  const root = resolve(repoPath);
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].map((file) => join(root, file)).find((path) => existsSync(path));
}

export function releaseGateLocalD1DatabaseName(repoPath: string) {
  const wranglerPath = join(resolve(repoPath), 'wrangler.toml');
  if (!existsSync(wranglerPath)) return undefined;

  const text = readFileSync(wranglerPath, 'utf8');
  return firstTomlStringValue(text, 'database_name') ?? firstTomlStringValue(text, 'name');
}

function sourceTreeContainsText(rootPath: string, needle: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeContainsText(path, needle, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (readFileSync(path, 'utf8').includes(needle)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function releaseGateRepoHasRoute(repoPath: string, route: string) {
  const root = resolve(repoPath);
  if (route === '/health' && existsSync(join(root, 'src/routes/health.ts'))) return true;
  return sourceTreeContainsText(join(root, 'src'), route);
}

function releaseGateMigrationText(repoPath: string) {
  const migrationsPath = join(resolve(repoPath), 'migrations');
  if (!existsSync(migrationsPath)) return '';

  return readdirSync(migrationsPath)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsPath, file), 'utf8'))
    .join('\n');
}

function releaseGateTranscriptFixtureAvailable(repoPath: string) {
  const schema = releaseGateMigrationText(repoPath);
  return (
    Boolean(releaseGateLocalD1DatabaseName(repoPath)) &&
    releaseGateRepoHasRoute(repoPath, '/latest') &&
    /\bCREATE\s+TABLE\s+runs\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+candidates\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+transcripts\b/i.test(schema)
  );
}

function releaseGateTranscriptFixtureSql() {
  return [
    '-- Release-gate fixture: completed run plus original and regenerated transcript versions.',
    "INSERT OR REPLACE INTO candidates (id, run_id, bookmark_id, link_id, source_url, title, author, published_at, summary, core_idea, suggested_angle, primary_segment, segment_fit_json, created_at) VALUES ('release-gate-candidate', 'release-gate-run', 'release-gate-bookmark', NULL, 'https://example.com/release-gate-source', 'Release Gate Candidate', 'Release Gate', '2026-01-01T00:00:00.000Z', 'Fixture candidate for release-gate transcript persistence.', 'Prove completed transcript persistence through GET /latest.', 'Show that the latest transcript is served from D1.', 'operators', '[{\"segmentName\":\"operators\",\"relevance\":5}]', '2026-01-01T00:00:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v1', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Original Transcript', 'Original hook.', 'Original transcript retained for audit.', '[\"Original caption\"]', '[\"https://example.com/release-gate-source\"]', 'Original selection rationale.', 'operators', '[\"Original alternate angle\"]', 5, '2026-01-01T00:05:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v2', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Regenerated Transcript', 'Regenerated hook.', 'Regenerated transcript served as latest while the original remains stored.', '[\"Regenerated caption\"]', '[\"https://example.com/release-gate-source\"]', 'Regenerated selection rationale.', 'operators', '[\"Regenerated alternate angle\"]', 9, '2026-01-01T00:10:00.000Z');",
    "INSERT OR REPLACE INTO runs (id, status, window_start, window_end, audience_profile_id, voice_profile_id, selected_candidate_id, transcript_id, error_message, created_at, updated_at) VALUES ('release-gate-run', 'completed', '2025-12-25T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'release-gate-audience', 'release-gate-voice', 'release-gate-candidate', 'release-gate-transcript-v2', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z');",
    '',
  ].join('\n');
}

function writeReleaseGateTranscriptFixtureFile(repoPath: string) {
  const fixturePath = join(resolve(repoPath), '.delivery', 'tmp', 'release-gate-transcript-fixture.sql');
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, releaseGateTranscriptFixtureSql());
  return '.delivery/tmp/release-gate-transcript-fixture.sql';
}

export function releaseGateWorkerDevCommand(
  repoPath: string,
  port: number | '<port>' = '<port>',
  persistTo?: string | '<persist-to>',
) {
  if (!releaseGateWorkerConfigPath(repoPath)) return undefined;

  const scripts = packageScripts(repoPath);
  const devScript = scripts.dev;
  const portValue = String(port);
  const persistArgs = persistTo ? ['--persist-to', String(persistTo)] : [];
  const persistCommand = persistTo ? ` --persist-to ${String(persistTo)}` : '';
  if (typeof devScript === 'string' && /\bwrangler\s+dev\b/.test(devScript)) {
    return {
      command: `npm run dev -- --ip 127.0.0.1 --port ${portValue}${persistCommand}`,
      executable: 'npm',
      args: ['run', 'dev', '--', '--ip', '127.0.0.1', '--port', portValue, ...persistArgs],
    } satisfies ReleaseGateProcessCommand;
  }

  return {
    command: `npx wrangler dev --ip 127.0.0.1 --port ${portValue}${persistCommand}`,
    executable: 'npx',
    args: ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', portValue, ...persistArgs],
  } satisfies ReleaseGateProcessCommand;
}

export function releaseGateRuntimeProbePlan(repoPath: string): ReleaseGateRuntimeProbePlan | undefined {
  const command = releaseGateWorkerDevCommand(repoPath);
  if (!command) return undefined;

  const probes: ReleaseGateHttpProbePlan[] = [
    {
      method: 'GET',
      path: '/',
      expected: 'Local Worker runtime responds with an HTTP status below 500.',
      statusBelow: 500,
      reason: 'A non-5xx response proves wrangler dev started and can serve local Worker requests.',
    },
  ];

  if (releaseGateRepoHasRoute(repoPath, '/health')) {
    probes.push({
      method: 'GET',
      path: '/health',
      expected: 'GET /health returns HTTP 200 JSON with status "ok".',
      expectedStatus: 200,
      jsonContains: { status: 'ok' },
      reason: 'A health route was present in the source tree.',
    });
  }

  if (releaseGateRepoHasRoute(repoPath, '/latest')) {
    if (releaseGateTranscriptFixtureAvailable(repoPath)) {
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

  if (releaseGateRepoHasRoute(repoPath, '/runs')) {
    probes.push(
      {
        method: 'POST',
        path: '/runs',
        expected: 'POST /runs rejects invalid JSON with HTTP 400 and error "invalid_json".',
        expectedStatus: 400,
        body: { type: 'text', value: '{not-json', contentType: 'application/json' },
        jsonContains: { error: 'invalid_json' },
        reason: 'The run creation route was present and should give actionable malformed-body feedback.',
      },
      {
        method: 'POST',
        path: '/runs',
        expected: 'POST /runs without active profiles returns HTTP 409 and error "missing_active_profile".',
        expectedStatus: 409,
        body: { type: 'json', value: {} },
        jsonContains: { error: 'missing_active_profile' },
        reason: 'The run creation route depends on active profiles and should fail closed in a clean local state.',
      },
    );
  }

  if (releaseGateRepoHasRoute(repoPath, '/profiles')) {
    probes.push(
      {
        method: 'POST',
        path: '/profiles',
        expected: 'POST /profiles rejects non-multipart requests with HTTP 400.',
        expectedStatus: 400,
        body: { type: 'json', value: { kind: 'audience_segments' } },
        jsonContains: { error: 'Request must be multipart/form-data' },
        reason: 'The profile upload route was present and should validate request shape before storage writes.',
      },
      {
        method: 'POST',
        path: '/profiles',
        expected: 'POST /profiles stores an active audience profile through D1 and R2.',
        expectedStatus: 201,
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
    command,
    probes,
    required: true,
    reason: 'A Wrangler Worker config was present, so local runtime verification is required before deployment.',
  };
}

function createReleaseGateRuntimeStatePath(repoPath: string) {
  const stateRoot = join(resolve(repoPath), '.delivery', 'tmp');
  mkdirSync(stateRoot, { recursive: true });
  const persistTo = join(stateRoot, `wrangler-state-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  mkdirSync(persistTo, { recursive: true });
  return persistTo;
}

export function releaseGateEvidenceCommandPlan(repoPath: string, persistTo?: string): ReleaseGateEvidenceCommand[] {
  const commands: ReleaseGateEvidenceCommand[] = [];
  const script = buildVerificationScript(repoPath);
  if (script) {
    commands.push({
      tier: 'smoke',
      command: `npm run ${script}`,
      executable: 'npm',
      args: ['run', script],
      required: true,
      reason: `Project verification script "${script}" was available.`,
    });
  }

  const databaseName = releaseGateLocalD1DatabaseName(repoPath);
  if (databaseName && existsSync(join(resolve(repoPath), 'migrations'))) {
    const persistArgs = persistTo ? ['--persist-to', persistTo] : [];
    const persistCommand = persistTo ? ` --persist-to ${persistTo}` : '';
    commands.push({
      tier: 'api',
      command: `npx wrangler d1 migrations apply ${databaseName} --local${persistCommand}`,
      executable: 'npx',
      args: ['wrangler', 'd1', 'migrations', 'apply', databaseName, '--local', ...persistArgs],
      required: false,
      reason: 'wrangler.toml and migrations/ were present, so local D1 migration validation was available.',
    });

    if (releaseGateTranscriptFixtureAvailable(repoPath)) {
      const fixturePath = writeReleaseGateTranscriptFixtureFile(repoPath);
      const versionAuditSql =
        "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = 'release-gate-transcript-v1' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = 'release-gate-transcript-v2' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = 'release-gate-run') AS active_transcript_id FROM transcripts WHERE run_id = 'release-gate-run'";
      commands.push(
        {
          tier: 'api',
          command: `npx wrangler d1 execute ${databaseName} --local${persistCommand} --file ${fixturePath} --json`,
          executable: 'npx',
          args: ['wrangler', 'd1', 'execute', databaseName, '--local', ...persistArgs, '--file', fixturePath, '--json'],
          required: true,
          reason:
            'A latest transcript route and transcript schema were present, so release gate seeds a completed run with original and regenerated transcript versions.',
        },
        {
          tier: 'api',
          command: `npx wrangler d1 execute ${databaseName} --local${persistCommand} --command "${versionAuditSql}" --json`,
          executable: 'npx',
          args: ['wrangler', 'd1', 'execute', databaseName, '--local', ...persistArgs, '--command', versionAuditSql, '--json'],
          required: true,
          reason:
            'Transcript regeneration data-safety evidence: expected transcript_versions=2, preserved_original_versions=1, regenerated_versions=1, and active_transcript_id=release-gate-transcript-v2.',
        },
      );
    }
  }

  return commands;
}

export function releaseGateStaticEvidenceResults(repoPath: string): ReleaseGateEvidenceResult[] {
  const aiGaps = workersAiBindingGaps(repoPath);
  if (!repoSourceUsesWorkersAi(repoPath) && !aiGaps.length) return [];

  const ok = aiGaps.length === 0;
  return [
    {
      tier: 'api',
      command: 'static check: Workers AI binding configured',
      ok,
      required: true,
      reason: 'Source uses Workers AI, so the Worker must expose a real AI binding before AI-backed routes or workflows can be accepted.',
      output_summary: ok ? 'Wrangler config contains active Workers AI binding and Env.AI is required.' : undefined,
      error: ok ? undefined : aiGaps.join(' '),
    },
  ];
}

async function recordReleaseGateStaticEvidenceResult({
  repoPath,
  mastra,
  stage,
  result,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  result: ReleaseGateEvidenceResult;
}) {
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code',
      stage,
      command: result.command,
      ok: result.ok,
      output_summary: result.output_summary,
      error: result.error,
    },
  });
}

async function runReleaseGateEvidenceCommand({
  repoPath,
  mastra,
  stage,
  command,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: ReleaseGateEvidenceCommand;
}): Promise<ReleaseGateEvidenceResult> {
  await recordRunCodeStart({
    repoPath,
    mastra,
    stage,
    command: command.command,
    timeoutMs: command.tier === 'smoke' ? 120_000 : 180_000,
  });
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: resolve(repoPath),
      timeout: command.tier === 'smoke' ? 120_000 : 180_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    const output = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 700);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: true,
        output_summary: output,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: true,
      required: command.required,
      reason: command.reason,
      output_summary: output,
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: false,
      required: command.required,
      reason: command.reason,
      error: failure,
    };
  }
}

function appendBoundedOutput(current: string, chunk: unknown, limit = 24_000) {
  const next = `${current}${String(chunk)}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function delay(ms: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function availableTcpPort() {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local TCP port for the Worker runtime probe.'));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function waitForChildExit(child: ChildProcess) {
  return new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.once('exit', () => resolveExit());
  });
}

function signalChildProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child signaling when process-group signaling is unavailable.
    }
  }

  child.kill(signal);
}

async function stopChildProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalChildProcess(child, 'SIGTERM');
  await Promise.race([waitForChildExit(child), delay(3_000)]);

  if (child.exitCode === null && child.signalCode === null) {
    signalChildProcess(child, 'SIGKILL');
    await Promise.race([waitForChildExit(child), delay(1_000)]);
  }
}

function probeStatusMatches(probe: ReleaseGateHttpProbePlan, status: number) {
  if (probe.expectedStatus !== undefined) return status === probe.expectedStatus;
  if (probe.statusBelow !== undefined) return status < probe.statusBelow;
  return status >= 200 && status < 400;
}

function jsonContainsExpected(
  body: string,
  expected: Record<string, string | number | boolean | null>,
): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactDiagnostic(error, 300)}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response JSON was not an object.' };
  }

  const record = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      return { ok: false, error: `Expected JSON field ${key}=${JSON.stringify(value)}, received ${JSON.stringify(record[key])}.` };
    }
  }

  return { ok: true };
}

function recordContainsExpected(
  record: Record<string, unknown>,
  expected: Record<string, string | number | boolean | null>,
) {
  return Object.entries(expected).every(([key, value]) => record[key] === value);
}

function jsonArrayAssertionsExpected(body: string, assertions: ReleaseGateJsonArrayAssertion[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactDiagnostic(error, 300)}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Response JSON was not an array.' };
  }

  const records = parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  for (const assertion of assertions) {
    if (assertion.type === 'minLength' && parsed.length < assertion.min) {
      return { ok: false, error: `Expected JSON array length at least ${assertion.min}, received ${parsed.length}.` };
    }

    if (assertion.type === 'containsObject' && !records.some((record) => recordContainsExpected(record, assertion.where))) {
      return { ok: false, error: `Expected JSON array to contain object fields ${JSON.stringify(assertion.where)}.` };
    }

    if (assertion.type === 'countObjects') {
      const count = records.filter((record) => recordContainsExpected(record, assertion.where)).length;
      if (count !== assertion.count) {
        return {
          ok: false,
          error: `Expected ${assertion.count} JSON array object(s) matching ${JSON.stringify(assertion.where)}, received ${count}.`,
        };
      }
    }
  }

  return { ok: true };
}

function requestInitForProbe(probe: ReleaseGateHttpProbePlan): RequestInit {
  const init: RequestInit = {
    method: probe.method,
    headers: probe.headers,
    signal: AbortSignal.timeout(5_000),
  };

  if (!probe.body) return init;

  if (probe.body.type === 'json') {
    return {
      ...init,
      headers: { 'content-type': 'application/json', ...probe.headers },
      body: JSON.stringify(probe.body.value),
    };
  }

  if (probe.body.type === 'text') {
    return {
      ...init,
      headers: { 'content-type': probe.body.contentType ?? 'text/plain', ...probe.headers },
      body: probe.body.value,
    };
  }

  const form = new FormData();
  form.set('kind', probe.body.kind);
  form.set('setActive', String(probe.body.setActive ?? true));
  form.set('file', new Blob([probe.body.markdown], { type: 'text/markdown' }), probe.body.filename);
  return {
    ...init,
    body: form,
  };
}

async function runHttpProbe(baseUrl: string, probe: ReleaseGateHttpProbePlan): Promise<ReleaseGateHttpProbeResult> {
  const url = new URL(probe.path, baseUrl).toString();
  try {
    const response = await fetch(url, requestInitForProbe(probe));
    const body = await response.text();
    const statusOk = probeStatusMatches(probe, response.status);
    const jsonCheck = probe.jsonContains ? jsonContainsExpected(body, probe.jsonContains) : { ok: true };
    const jsonArrayCheck = probe.jsonArrayAssertions
      ? jsonArrayAssertionsExpected(body, probe.jsonArrayAssertions)
      : { ok: true };
    const ok = statusOk && jsonCheck.ok && jsonArrayCheck.ok;
    const summary = [
      `HTTP ${response.status}`,
      response.headers.get('content-type') ? `content-type ${response.headers.get('content-type')}` : undefined,
      body.trim() ? `body ${compactDiagnostic(body.trim(), 300)}` : undefined,
    ]
      .filter(Boolean)
      .join('; ');

    return {
      method: probe.method,
      path: probe.path,
      url,
      expected: probe.expected,
      ok,
      status: response.status,
      response_summary: summary,
      error: ok
        ? undefined
        : jsonCheck.error ?? jsonArrayCheck.error ?? `Expected ${probe.expected}, received HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      method: probe.method,
      path: probe.path,
      url,
      expected: probe.expected,
      ok: false,
      error: compactDiagnostic(error, 500),
    };
  }
}

async function runReleaseGateRuntimeProbe({
  repoPath,
  mastra,
  stage,
  persistTo,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  persistTo?: string;
}): Promise<ReleaseGateEvidenceResult | undefined> {
  const plan = releaseGateRuntimeProbePlan(repoPath);
  if (!plan) return undefined;

  const port = await availableTcpPort();
  const command = releaseGateWorkerDevCommand(repoPath, port, persistTo ?? createReleaseGateRuntimeStatePath(repoPath));
  if (!command) return undefined;

  let output = '';
  let processError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let probes: ReleaseGateHttpProbeResult[] = [];
  await recordRunCodeStart({ repoPath, mastra, stage, command: command.command, timeoutMs: 75_000 });
  const child = spawn(command.executable, command.args, {
    cwd: resolve(repoPath),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      CI: process.env.CI ?? '1',
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.once('error', (error) => {
    processError = error;
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 75_000;
  try {
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (exit) throw new Error(`Worker runtime command exited before probes passed: code ${exit.code}, signal ${exit.signal}.`);

      probes = [];
      for (const probe of plan.probes) {
        probes.push(await runHttpProbe(baseUrl, probe));
      }

      if (probes.every((probe) => probe.ok)) {
        const outputSummary = compactDiagnostic(output.trim() || 'wrangler dev served all runtime probes.', 900);
        await appendDeliveryEventState({
          repoPath,
          mastra,
          event: {
            type: 'run_code',
            stage,
            command: command.command,
            ok: true,
            output_summary: outputSummary,
            probes,
          },
        });
        return {
          tier: plan.tier,
          command: command.command,
          ok: true,
          required: plan.required,
          reason: plan.reason,
          output_summary: outputSummary,
          probes,
        };
      }

      await delay(1_000);
    }

    throw new Error(`Worker runtime probes did not pass within 75s. Last probe results: ${JSON.stringify(probes)}`);
  } catch (error) {
    const failure = compactDiagnostic(`${compactDiagnostic(error, 900)}\n${output}`, 1_400);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
        probes,
      },
    });
    return {
      tier: plan.tier,
      command: command.command,
      ok: false,
      required: plan.required,
      reason: plan.reason,
      error: failure,
      probes,
    };
  } finally {
    await stopChildProcess(child);
  }
}

async function collectReleaseGateEvidence({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<ReleaseGateEvidence> {
  await ensureNodeDependencies({ repoPath, mastra, stage });

  const runtimePlan = releaseGateRuntimeProbePlan(repoPath);
  const runtimePersistTo = runtimePlan ? createReleaseGateRuntimeStatePath(repoPath) : undefined;
  const plan = releaseGateEvidenceCommandPlan(repoPath, runtimePersistTo);
  const notes: string[] = [];
  if (!plan.some((command) => command.tier === 'smoke')) {
    notes.push('No package verification script was available; smoke tier must be marked not_required or blocked with a reason.');
  }
  if (!plan.some((command) => command.tier === 'api') && !runtimePlan) {
    notes.push('No local D1 migration command or Worker runtime probe was planned; API tier should be not_required unless other API evidence exists.');
  }
  if (!runtimePlan) {
    notes.push('No Wrangler Worker config was detected, so local Worker runtime startup was not probed.');
  }
  if (releaseGateTranscriptFixtureAvailable(repoPath)) {
    notes.push(
      'Release gate seeds D1 with a completed run containing original and regenerated transcript versions, then probes GET /latest against the same local Wrangler state.',
    );
  }
  notes.push('No browser E2E harness is started by this workflow; E2E and full_matrix tiers should be not_required unless cited evidence exists.');

  const commands: ReleaseGateEvidenceResult[] = [];
  for (const command of plan) {
    commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
  }
  for (const result of releaseGateStaticEvidenceResults(repoPath)) {
    await recordReleaseGateStaticEvidenceResult({ repoPath, mastra, stage, result });
    commands.push(result);
  }
  const runtimeResult = await runReleaseGateRuntimeProbe({ repoPath, mastra, stage, persistTo: runtimePersistTo });
  if (runtimeResult) commands.push(runtimeResult);

  return {
    artifact_type: 'test-evidence',
    stage,
    commands,
    notes,
  };
}

function acceptanceCriterionCovered(criterion: string, performed: string[]) {
  const text = criterion.toLowerCase();
  const evidence = performed.join('\n').toLowerCase();

  if (/\b(typecheck|tsc|typescript)\b/.test(text)) return /\b(typecheck|tsc)\b/.test(evidence);
  if (/\btest(s|ing)?\b/.test(text)) return /\btest\b/.test(evidence);
  if (/\bbuild\b/.test(text)) return /\bbuild\b/.test(evidence);
  if (/\bwrangler dev\b/.test(text)) return /\bwrangler dev\b/.test(evidence);
  if (/\bhealth\b|\/health\b|http 200|status 200/.test(text)) return /\bhealth\b|\/health\b|http 200|status 200/.test(evidence);

  return false;
}

export function verificationWithAcceptanceGaps({
  repoPath,
  task,
  verification,
}: {
  repoPath?: string;
  task: Task;
  verification: { performed: string[]; missing: string[] };
}) {
  const missing = new Set(verification.missing);
  if (repoPath) {
    for (const path of missingOwnedSurfacePaths(repoPath, task)) {
      missing.add(`Owned surface missing after implementation: ${path}`);
    }
  }
  for (const criterion of task.acceptance_criteria) {
    if (!acceptanceCriterionCovered(criterion, verification.performed)) {
      missing.add(`Acceptance criterion not verified by automated checks: ${criterion}`);
    }
  }

  return {
    performed: verification.performed,
    missing: [...missing],
  };
}

async function applyBuildVerificationRepair({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  failure,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  failure: string;
}) {
  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairStaleDownstreamVerificationSurfaces({
      repoPath,
      mastra,
      stage,
      taskPlan,
      currentTaskIndex: taskIndex,
      failure,
    }))
  ) {
    return true;
  }

  if (!/Cannot find name 'WorkflowEvent'/.test(failure)) return false;

  const path = 'src/workflows/weekly.ts';
  const fullPath = join(resolve(repoPath), path);
  if (!existsSync(fullPath)) return false;

  const source = readFileSync(fullPath, 'utf8');
  const next = source.replace(
    "import { WorkflowEntrypoint } from 'cloudflare:workers';",
    "import { WorkflowEntrypoint, type WorkflowEvent } from 'cloudflare:workers';",
  );
  if (next === source) return false;

  writeFileSync(fullPath, next);
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: [path],
      output_summary: 'Imported WorkflowEvent from cloudflare:workers after typecheck failure.',
    },
  });
  return true;
}

function commandFailureSummary(error: unknown, limit = 1000) {
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const parts = [
      typeof record.message === 'string' ? record.message : undefined,
      typeof record.stdout === 'string' && record.stdout.trim() ? `stdout:\n${record.stdout}` : undefined,
      typeof record.stderr === 'string' && record.stderr.trim() ? `stderr:\n${record.stderr}` : undefined,
    ].filter(Boolean);
    if (parts.length) {
      const text = parts.join('\n');
      return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
    }
  }

  return compactDiagnostic(error, limit);
}

function synthesizeImplementationNote({
  repoPath,
  stage,
  task,
  taskPlan,
  events,
  buildResponse,
  verification,
}: {
  repoPath: string;
  stage: string;
  task: Task;
  taskPlan: TaskPlan;
  events: DeliveryEvent[];
  buildResponse: unknown;
  verification: { performed: string[]; missing: string[] };
}): ImplementationNote {
  const filesTouched = implementationFilesTouched({ repoPath, stage, task, events });
  const summary = responseText(buildResponse);
  const honestVerification = verificationWithAcceptanceGaps({ repoPath, task, verification });

  return {
    artifact_type: 'implementation-note',
    task: task.id,
    changes: [
      `Implemented ${task.id}: ${task.deliverable}`,
      ...(summary ? [`Engineer response: ${compactDiagnostic(summary, 500)}`] : []),
    ],
    files_touched: filesTouched,
    assumptions: taskPlan.open_decisions,
    verification: honestVerification,
    risks: taskPlan.risks,
  };
}

function implementationDeterministicResults({
  repoPath,
  stage,
  role,
  task,
  note,
  events,
  verification,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  task: Task;
  note: ImplementationNote;
  events: DeliveryEvent[];
  verification: { performed: string[]; missing: string[] };
}): DeterministicGateResult[] {
  const files = repoFileContents(repoPath, note.files_touched);
  const missingSurfaces = missingOwnedSurfacePaths(repoPath, task);
  const unreplacedStubs = unreplacedPreflightStubPaths(repoPath, task);
  const workflowIntegrationGaps = workflowStepIntegrationGaps(repoPath, task);
  const routeMiddlewareGaps = routeMiddlewareBypassGaps(repoPath, task);
  const aiBindingGaps = workersAiBindingGaps(repoPath, task);
  const lifecycleStatusGaps = lifecycleStatusSchemaGaps(repoPath, task);
  const profileKindGaps = profileKindContractGaps(repoPath, task);
  const noteOwnership = runDeterministicCheck({
    name: 'file_ownership',
    role,
    paths: note.files_touched,
  });
  const eventOwnership = runDeterministicCheck({
    name: 'write_paths_in_boundary',
    events,
    stage,
    role,
  });
  const ownership = noteOwnership.passed ? eventOwnership : noteOwnership;
  const moduleLoads = runDeterministicCheck({
    name: 'ran_code_before_complete',
    events,
    stage,
  });
  const crypto = noBcryptWeakHash(files);
  const failedVerification = verification.missing.find((item) => /\bfailed:/i.test(item));

  return [
    { id: 'file_ownership', check: 'write_paths_in_boundary', ...ownership },
    {
      id: 'owned_surfaces_present',
      check: 'owned_surfaces_present',
      passed: missingSurfaces.length === 0,
      reason: missingSurfaces.length ? `missing owned surfaces: ${missingSurfaces.join(', ')}` : 'ok',
    },
    {
      id: 'preflight_stubs_replaced',
      check: 'preflight_stubs_replaced',
      passed: unreplacedStubs.length === 0,
      reason: unreplacedStubs.length ? `preflight stubs remain: ${unreplacedStubs.join(', ')}` : 'ok',
    },
    {
      id: 'workflow_step_integrated',
      check: 'workflow_step_integrated',
      passed: workflowIntegrationGaps.length === 0,
      reason: workflowIntegrationGaps.length ? workflowIntegrationGaps.join('; ') : 'ok',
    },
    {
      id: 'route_middleware_layering',
      check: 'middleware_layering',
      passed: routeMiddlewareGaps.length === 0,
      reason: routeMiddlewareGaps.length ? routeMiddlewareGaps.join('; ') : 'ok',
    },
    {
      id: 'workers_ai_binding_required',
      check: 'workers_ai_binding_required',
      passed: aiBindingGaps.length === 0,
      reason: aiBindingGaps.length ? aiBindingGaps.join('; ') : 'ok',
    },
    {
      id: 'lifecycle_status_schema_constrained',
      check: 'state_explicitness',
      passed: lifecycleStatusGaps.length === 0,
      reason: lifecycleStatusGaps.length ? lifecycleStatusGaps.join('; ') : 'ok',
    },
    {
      id: 'profile_kind_contract_aligned',
      check: 'profile_kind_contract',
      passed: profileKindGaps.length === 0,
      reason: profileKindGaps.length ? profileKindGaps.join('; ') : 'ok',
    },
    { id: 'module_loads', check: 'ran_code_before_complete', ...moduleLoads },
    {
      id: 'verification_passed',
      check: 'build_verification_passed',
      passed: verification.performed.length > 0 && !failedVerification,
      reason: failedVerification ?? (verification.performed.length ? 'ok' : 'no build verification command passed'),
    },
    { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', ...crypto },
  ];
}

export function implementationDeterministicRemediation(results: DeterministicGateResult[]) {
  return results
    .filter((result) => !result.passed)
    .filter((result) =>
      [
        'file_ownership',
        'write_paths_in_boundary',
        'owned_surfaces_present',
        'preflight_stubs_replaced',
        'workflow_step_integrated',
        'route_middleware_layering',
        'middleware_layering',
        'workers_ai_binding_required',
        'lifecycle_status_schema_constrained',
        'state_explicitness',
        'profile_kind_contract_aligned',
        'profile_kind_contract',
        'module_loads',
        'ran_code_before_complete',
        'verification_passed',
        'build_verification_passed',
      ].includes(String(result.id ?? result.check)),
    )
    .map((result) => {
      const id = String(result.id ?? result.check ?? 'deterministic_check');
      return `DETERMINISTIC ${id} failed: ${result.reason ?? 'no reason recorded'}`;
    });
}

function releaseGateDeterministicResults({
  stage,
  gate,
  events,
}: {
  stage: string;
  gate: ReleaseGate;
  events: DeliveryEvent[];
}): DeterministicGateResult[] {
  return [
    { id: 'decision_explicit', check: 'plan_schema_complete', ...planSchemaComplete(gate) },
    { id: 'tier_order', check: 'tier_order', ...runDeterministicCheck({ name: 'tier_order', subject: gate }) },
    {
      id: 'pass_with_open_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: gate }),
    },
    {
      id: 'critical_area_evidence_trajectory',
      check: 'harness_run_before_findings',
      ...runDeterministicCheck({ name: 'harness_run_before_findings', events, stage }),
    },
  ];
}

export function releaseGateForInvalidTesterOutput(error: unknown): ReleaseGate {
  const diagnostic = compactDiagnostic(error, 900);
  const reason = `Tester did not return a structured release-gate object: ${diagnostic}`;

  return {
    artifact_type: 'release-gate',
    decision: 'fail',
    event_type: 'pre_deployment',
    tiers: [
      {
        tier: 'smoke',
        status: 'failed',
        reason,
      },
      {
        tier: 'api',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'e2e',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'full_matrix',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
    ],
    critical_areas: [
      'auth',
      'billing',
      'state_integrity',
      'data_safety',
      'deployment_correctness',
      'error_responses',
    ].map((area) => ({
      area: area as ReleaseGate['critical_areas'][number]['area'],
      status: 'missing' as const,
      reason,
    })),
    blockers: [
      reason,
      'Rerun the release gate and return only { "gate": <release-gate> } after executing evidence commands.',
    ],
    cosmetic_issues: [],
    summary: 'Release gate failed closed because the tester returned malformed structured output.',
  };
}

function deploymentDeterministicResults({
  stage,
  releaseGate,
  events,
}: {
  stage: string;
  releaseGate: ReleaseGate;
  events: DeliveryEvent[];
}): DeterministicGateResult[] {
  return [
    {
      id: 'no_deploy_through_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: releaseGate, mode: 'deployable' }),
    },
    {
      id: 'no_deploy_through_blockers_trajectory',
      check: 'release_gate_read_before_deploy',
      ...runDeterministicCheck({ name: 'release_gate_read_before_deploy', events, stage }),
    },
    {
      id: 'verification_evidence_present_trajectory',
      check: 'live_verify_after_deploy',
      ...runDeterministicCheck({ name: 'live_verify_after_deploy', events, stage }),
    },
  ];
}

function latestArtifactPath(artifacts: string[], needle: string, fallback: string) {
  return [...artifacts].reverse().find((path) => path.includes(needle) && !path.includes('/judgments/')) ?? fallback;
}

const requiredAgent = (mastra: any, id: string) => {
  const agent = mastra?.getAgentById(id);
  if (!agent) throw new Error(`${id} agent is not registered`);
  return agent as {
    generate: (message: string, options: Record<string, unknown>) => Promise<{ object?: unknown; text?: string }>;
  };
};

const structuredNoToolOptions = {
  activeTools: [] as string[],
  maxSteps: 1,
};

const deployerAgentMaxSteps = 8;

const implementationWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

const implementationWriteOnlyWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
] as string[];

const implementationRepairWorkspaceTools = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
] as string[];

const envTimeoutMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const deliveryAgentTimeouts = {
  standard: envTimeoutMs('DELIVERY_AGENT_CALL_TIMEOUT_MS', 300_000),
  build: envTimeoutMs('DELIVERY_BUILD_CALL_TIMEOUT_MS', 180_000),
  buildNoTool: envTimeoutMs('DELIVERY_BUILD_NO_TOOL_TIMEOUT_MS', 60_000),
  buildPostWriteQuiet: envTimeoutMs('DELIVERY_BUILD_POST_WRITE_QUIET_TIMEOUT_MS', 90_000),
  judge: envTimeoutMs('DELIVERY_JUDGE_CALL_TIMEOUT_MS', 300_000),
};

class DeliveryStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = 'DeliveryStageTimeoutError';
  }
}

class DeliveryNoToolCallTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no tool calls after ${timeoutMs}ms`);
    this.name = 'DeliveryNoToolCallTimeoutError';
  }
}

class DeliveryPostWriteQuietTimeoutError extends DeliveryStageTimeoutError {
  constructor(stage: string, timeoutMs: number) {
    super(stage, timeoutMs, `Delivery stage "${stage}" made no progress for ${timeoutMs}ms after a workspace write`);
    this.name = 'DeliveryPostWriteQuietTimeoutError';
  }
}

export type JudgeProviderErrorDetails = {
  name: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
  code?: string;
  url?: string;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringProperty(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberProperty(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function judgeProviderErrorDetails(error: unknown): JudgeProviderErrorDetails | undefined {
  if (error instanceof DeliveryStageTimeoutError) return undefined;

  const record = objectValue(error);
  const dataError = objectValue(objectValue(record?.data)?.error);
  const name = error instanceof Error ? error.name : stringProperty(record, 'name') ?? 'Error';
  const message = compactDiagnostic(error, 300);
  const statusCode = numberProperty(record, 'statusCode') ?? numberProperty(record, 'status');
  const code = stringProperty(dataError, 'code') ?? stringProperty(record, 'code');
  const url = stringProperty(record, 'url');
  const retryable =
    record?.isRetryable === true ||
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    (typeof statusCode === 'number' && statusCode >= 500) ||
    /\b(overloaded|temporarily unavailable|try again later|rate.?limit|timeout|timed out)\b/i.test(message);
  const providerShaped =
    /\bAI_?APICallError\b|\bAPICallError\b/i.test(name) ||
    typeof statusCode === 'number' ||
    Boolean(url && /\/chat\/completions\b/.test(url));

  if (!providerShaped) return undefined;
  return { name, message, retryable, statusCode, code, url };
}

function judgeProviderEvidence(stage: string, details: JudgeProviderErrorDetails) {
  const status = details.statusCode ? ` status ${details.statusCode}` : '';
  const code = details.code ? ` code ${details.code}` : '';
  const retry = details.retryable ? 'retryable provider error' : 'provider error';
  return `${stage} unavailable: ${details.name}${status}${code}; ${retry}; ${details.message}`;
}

export function judgeUnavailableRemediation(stage: string, details: JudgeProviderErrorDetails) {
  const action = details.retryable
    ? 'Retry the delivery run; no target-code change is implied by this judge outage.'
    : 'Fix the judge model configuration or provider access, then rerun delivery.';
  return `JUDGE_UNAVAILABLE ${stage}: ${judgeProviderEvidence(stage, details)}. ${action}`;
}

export function judgeUnavailableOutputForRubric({
  rubric,
  details,
  stage,
}: {
  rubric: Rubric;
  details: JudgeProviderErrorDetails;
  stage: string;
}): JudgeOutput {
  const evidence = judgeProviderEvidence(stage, details);
  return {
    gates: (rubric.gates ?? [])
      .filter((gate) => !deterministicCheckNameForGate(gate))
      .map((gate) => ({
        id: gate.id,
        passed: false,
        evidence,
      })),
    dimensions: (rubric.dimensions ?? []).map((dimension) => ({
      id: dimension.id,
      score: null,
      evidence,
      not_scored_reason: details.retryable ? 'retryable_judge_provider_error' : 'judge_provider_error',
    })),
  };
}

async function stageHasToolUse({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return stageSlice(readDeliveryEvents(repoPath), stage).some((event) => event.type === 'tool_use');
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return stageSlice(events, stage).some((event) => event.type === 'tool_use');
}

const writeToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

export function latestSuccessfulWorkspaceWriteEventTimestamp(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const scoped = stageSlice(events, stage);
  for (let index = scoped.length - 1; index >= 0; index -= 1) {
    const event = scoped[index];
    if (event.type !== 'tool_use' || event.ok !== true || typeof event.tool !== 'string') continue;
    if (!writeToolNames.has(event.tool)) continue;

    const timestamp = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

async function latestStageSuccessfulWriteTimestamp({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return latestSuccessfulWorkspaceWriteEventTimestamp(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to the Mastra-backed state reader only if the local projection cannot be read.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return latestSuccessfulWorkspaceWriteEventTimestamp(events, { stage });
}

async function runWithDeliveryStageTimeout<T>({
  repoPath,
  mastra,
  stage,
  timeoutMs,
  firstToolTimeoutMs,
  firstToolCheck,
  postWriteQuietTimeoutMs,
  latestWriteCheck,
  operation,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  timeoutMs: number;
  firstToolTimeoutMs?: number;
  firstToolCheck?: () => Promise<boolean>;
  postWriteQuietTimeoutMs?: number;
  latestWriteCheck?: () => Promise<number | undefined>;
  operation: (abortSignal: AbortSignal) => Promise<T>;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstToolTimer: ReturnType<typeof setTimeout> | undefined;
  let postWriteQuietTimer: ReturnType<typeof setInterval> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(`Delivery stage "${stage}" timed out after ${timeoutMs}ms`);
      reject(new DeliveryStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  const firstToolTimeout =
    firstToolTimeoutMs && firstToolCheck
      ? new Promise<never>((_, reject) => {
          firstToolTimer = setTimeout(() => {
            firstToolCheck()
              .then((hasToolUse) => {
                if (hasToolUse) return;
                controller.abort(`Delivery stage "${stage}" made no tool calls after ${firstToolTimeoutMs}ms`);
                reject(new DeliveryNoToolCallTimeoutError(stage, firstToolTimeoutMs));
              })
              .catch(() => undefined);
          }, firstToolTimeoutMs);
          firstToolTimer.unref?.();
        })
      : undefined;
  const postWriteQuietTimeout =
    postWriteQuietTimeoutMs && latestWriteCheck
      ? new Promise<never>((_, reject) => {
          const pollMs = Math.min(5_000, postWriteQuietTimeoutMs);
          postWriteQuietTimer = setInterval(() => {
            latestWriteCheck()
              .then((latestWriteAt) => {
                if (!latestWriteAt) return;
                if (Date.now() - latestWriteAt < postWriteQuietTimeoutMs) return;

                controller.abort(
                  `Delivery stage "${stage}" made no progress for ${postWriteQuietTimeoutMs}ms after a workspace write`,
                );
                reject(new DeliveryPostWriteQuietTimeoutError(stage, postWriteQuietTimeoutMs));
              })
              .catch(() => undefined);
          }, pollMs);
          postWriteQuietTimer.unref?.();
        })
      : undefined;

  const work = operation(controller.signal);
  work.catch(() => undefined);

  try {
    return await Promise.race([
      work,
      timeout,
      ...(firstToolTimeout ? [firstToolTimeout] : []),
      ...(postWriteQuietTimeout ? [postWriteQuietTimeout] : []),
    ]);
  } catch (error) {
    if (error instanceof DeliveryStageTimeoutError) {
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event:
          error instanceof DeliveryNoToolCallTimeoutError
            ? { type: 'stage_no_tool_timeout', stage, timeout_ms: error.timeoutMs }
            : error instanceof DeliveryPostWriteQuietTimeoutError
              ? { type: 'stage_post_write_quiet_timeout', stage, timeout_ms: error.timeoutMs }
            : { type: 'stage_timeout', stage, timeout_ms: error.timeoutMs },
      }).catch(() => undefined);
      await endDeliveryStageState({ repoPath, stage, reason: 'max_turns', mastra }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (firstToolTimer) clearTimeout(firstToolTimer);
    if (postWriteQuietTimer) clearInterval(postWriteQuietTimer);
  }
}

async function judgeDeliveryArtifact({
  mastra,
  repoPath,
  rubricName,
  subjectName,
  subject,
  deterministicResults = [],
  slug,
}: {
  mastra: any;
  repoPath: string;
  rubricName: string;
  subjectName: string;
  subject: unknown;
  deterministicResults?: DeterministicGateResult[];
  slug: string;
}) {
  await startDeliveryStageState({
    repoPath,
    stage: `judge:${slug}`,
    role: 'judge',
    mastra,
  });

  const judge = requiredAgent(mastra, 'judge');
  const rubric = loadDeliveryEngineRubric(rubricName);
  const rubricJudgeOutputSchema = judgeOutputSchemaForRubric(rubric);
  const prompt = buildJudgeArtifactPrompt({
    rubric,
    subjectName,
    subject,
    deterministicResults,
  });
  const stage = `judge:${slug}`;
  let response: unknown;
  let judgeOutput: JudgeOutput;
  let providerFailureRemediation: string | undefined;

  try {
    response = await runWithDeliveryStageTimeout({
      repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.judge,
      operation: (abortSignal) =>
        judge.generate(
          prompt,
          {
            ...structuredNoToolOptions,
            abortSignal,
            requestContext: createDeliveryRequestContext(repoPath),
            structuredOutput: {
              schema: rubricJudgeOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the judge gates and dimensions. Do not compute aggregate scores.',
            },
          },
        ),
    });
    judgeOutput = parseDeliveryStructuredOutput(rubricJudgeOutputSchema, response, `${subjectName} judge`);
  } catch (error) {
    const details = judgeProviderErrorDetails(error);
    if (!details) throw error;

    providerFailureRemediation = judgeUnavailableRemediation(stage, details);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'judge_unavailable',
        stage,
        role: 'judge',
        ok: false,
        retryable: details.retryable,
        status_code: details.statusCode,
        code: details.code,
        error: details.message,
      },
    }).catch(() => undefined);

    response = {
      object: { judgeUnavailable: details },
      finishReason: 'error',
    };
    judgeOutput = judgeUnavailableOutputForRubric({ rubric, details, stage });
  }

  const parsedJudgeOutput = rubricJudgeOutputSchema.parse(judgeOutput);
  if (providerFailureRemediation) {
    parsedJudgeOutput.gates = parsedJudgeOutput.gates.map((gate) => ({
      ...gate,
      evidence: providerFailureRemediation,
    }));
    parsedJudgeOutput.dimensions = parsedJudgeOutput.dimensions.map((dimension) => ({
      ...dimension,
      evidence: providerFailureRemediation,
    }));
  }
  const judgeOutputPath = `.delivery/artifacts/judgments/${slug}.judge.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgeOutputPath,
    artifact: parsedJudgeOutput,
  });

  const judgment = aggregateJudgment({
    rubric,
    judgeOutput: parsedJudgeOutput,
    deterministicResults,
  });
  if (providerFailureRemediation) {
    judgment.remediation = [
      providerFailureRemediation,
      ...judgment.remediation.filter((item) => item !== providerFailureRemediation),
    ];
  }
  const judgmentPath = `.delivery/artifacts/judgments/${slug}.judgment.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgmentPath,
    artifact: judgment,
  });
  const tracePath = await writeStageTraceArtifact({
    repoPath,
    mastra,
    artifactType: `trace-judge-${slug}`,
    artifactPath: `.delivery/artifacts/traces/judge-${slug}.json`,
    trace: {
      artifact_type: 'agent-turn-trace',
      stage: `judge:${slug}`,
      role: 'judge',
      subject: subjectName,
      prompt,
      response: serializeAgentResponse(response),
      deterministicResults,
      judgeOutputPath,
      judgmentPath,
      judgment,
    },
  });
  await recordDeliveryJudgmentState({
    repoPath,
    subject: subjectName,
    rubric: judgment.rubric,
    path: judgmentPath,
    overall: judgment.overall,
    passed: judgment.passed,
    mastra,
  });

  await endDeliveryStageState({
    repoPath,
    stage: `judge:${slug}`,
    reason: judgment.passed ? 'complete_stage' : 'escalation',
    mastra,
  });

  const ref: JudgmentRef = {
    subject: subjectName,
    rubric: judgment.rubric,
    path: judgmentPath,
    overall: judgment.overall,
    passed: judgment.passed,
  };

  return {
    judgeOutputPath,
    judgmentPath,
    tracePath,
    judgment,
    ref,
  };
}

const createSyncDeliveryStageStateStep = (id: string, description: string) =>
  createStep({
    id,
    description,
    inputSchema: deliveryStageOutputSchema,
    outputSchema: deliveryStageOutputSchema,
    stateSchema: deliveryWorkflowStateSchema,
    execute: async ({ inputData, state, setState, mastra }) => {
      await syncDeliveryWorkflowState({ state, setState, output: inputData });
      await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
      return inputData;
    },
  });

const syncPlanStateStep = createSyncDeliveryStageStateStep(
  'sync-plan-state',
  'Persist plan gate output into the native workflow state snapshot.',
);
const syncReviewStateStep = createSyncDeliveryStageStateStep(
  'sync-review-state',
  'Persist architect review output into the native workflow state snapshot.',
);
const syncBuildStateStep = createSyncDeliveryStageStateStep(
  'sync-build-state',
  'Persist build aggregation output into the native workflow state snapshot.',
);
const syncReleaseGateStateStep = createSyncDeliveryStageStateStep(
  'sync-release-gate-state',
  'Persist release gate output into the native workflow state snapshot.',
);

const syncDeploymentReportStateStep = createStep({
  id: 'sync-deployment-report-state',
  description: 'Persist deployment report output into the native workflow state snapshot.',
  inputSchema: deploymentReportStageSchema,
  outputSchema: deploymentReportStageSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});

const syncFinalDeliveryStateStep = createStep({
  id: 'sync-final-delivery-state',
  description: 'Persist final delivery workflow output into the native workflow state snapshot.',
  inputSchema: workflowOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    await syncDeliveryWorkflowState({ state, setState, output: inputData });
    await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    return inputData;
  },
});

const initializeRunStep = createStep({
  id: 'initialize-delivery-run',
  description: 'Create delivery run state, export .delivery files, and persist the initial snapshot.',
  inputSchema: workflowInputSchema,
  outputSchema: initializedSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    const run = await initializeDeliveryRunState({ ...inputData, mastra });
    const repoPath = resolve(inputData.repoPath);
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath,
        runId: run.run_id,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        artifacts: [],
        checks: [],
        judgments: [],
        questions: [],
        nextSteps: [],
      },
    });
    await safePersistDeliveryStateWithMastra({ repoPath, mastra });

    return {
      ...inputData,
      repoPath,
      visionPath: run.vision,
      specPath: run.spec,
      runId: run.run_id,
      reviewMode: inputData.reviewMode,
    };
  },
});

const createPlannerArtifactsStep = createStep({
  id: 'create-planner-artifacts',
  description: 'Use the planner agent to create readout and task-plan artifacts.',
  inputSchema: initializedSchema,
  outputSchema: plannerArtifactsSchema,
  stateSchema: deliveryWorkflowStateSchema,
  resumeSchema: plannerQuestionsResumeSchema,
  suspendSchema: plannerQuestionsSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, state, setState }) => {
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      role: 'planner',
      mastra,
    });

    const planner = requiredAgent(mastra, 'planner');
    const humanAnswers = resumeData
      ? `\nHuman answers to prior blocking questions:\n${resumeData.answers
          .map((answer) => `- Q: ${answer.question}\n  A: ${answer.answer}`)
          .join('\n')}${resumeData.notes ? `\nAdditional notes: ${resumeData.notes}` : ''}\n`
      : '';
    const sourceDocuments = repoFileContents(inputData.repoPath, [inputData.visionPath, inputData.specPath]);
    if (sourceDocuments.length !== 2) {
      throw new Error(`planner could not load ${inputData.visionPath} and ${inputData.specPath}`);
    }
    const repoScaffoldState = {
      packageJson: existsSync(join(inputData.repoPath, 'package.json')) ? 'present' : 'missing',
      tsconfigJson: existsSync(join(inputData.repoPath, 'tsconfig.json')) ? 'present' : 'missing',
    };
    const sourceFingerprint = plannerSourceFingerprint(sourceDocuments);
    const cachedOutput = readCachedPlannerOutput({
      repoPath: inputData.repoPath,
      sourceFingerprint,
    });

    const output = cachedOutput
      ? { readout: cachedOutput.readout, taskPlan: cachedOutput.taskPlan }
      : parseDeliveryStructuredOutput(
          plannerOutputSchema,
          await runWithDeliveryStageTimeout({
            repoPath: inputData.repoPath,
            mastra,
            stage: 'plan',
            timeoutMs: deliveryAgentTimeouts.standard,
            operation: (abortSignal) =>
              planner.generate(
                `Use the source documents below. Do not call tools to read them. Produce:
1. A readout artifact.
2. A dependency-aware task-plan artifact.

Do not write code. Ask only blocking questions. Record safe assumptions in the readout.
Task owners must be engineer or designer. Verification, release gating, and deployment happen in later workflow stages, not task rows.
Every task must have checkable acceptance criteria and owned_surfaces.
Owned-surface hygiene:
- Every owned_surfaces entry must be a concrete repo path, for example wrangler.toml, src/index.ts, src/workflows/weekly.ts, public/settings.html, migrations/0001_schema.sql.
- Do not use wildcards such as src/**/*.ts, src/storage/*.ts, public/**, or src/**. Enumerate each expected file path.
- Do not use conceptual labels such as "Worker Env types", "wrangler configuration", "Workflow binding registration", "API routes", or "UI assets".
- If the exact file is genuinely unknowable, use "unknown: <why>" instead of a label.
Role-boundary hygiene:
- Engineer tasks own Worker config/source/migration files such as package.json, tsconfig.json, wrangler.toml, src/**, and migrations/**.
- Designer tasks own static UI files such as public/index.html, public/styles.css, public/app.js, and assets/**.
- Do not put public/** files in engineer-owned tasks; create or reuse a designer task for vanilla HTML/CSS/JS UI work.
Root scaffold hygiene:
- Target package.json is ${repoScaffoldState.packageJson}; target tsconfig.json is ${repoScaffoldState.tsconfigJson}.
- If package.json is missing and the plan creates a standalone Worker project, the first root engineer task must own package.json, tsconfig.json, and at least one TypeScript source input such as src/index.ts or src/env.ts.
- Worker runtime/config/source/static asset/migration tasks must depend on that scaffold task unless they own package.json and tsconfig.json themselves.
Open-decision hygiene:
- taskPlan.open_decisions is only for genuine blockers that prevent a task from being implemented safely.
- If an unknown can be resolved by a safe default, put it in readout.safe_assumptions, not taskPlan.open_decisions.
- If an unknown is a non-blocking delivery concern, put it in taskPlan.risks.
- Every open_decisions entry must be one string with this exact field shape:
  "Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
- The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.
Return only JSON matching this top-level shape: { "readout": {...}, "taskPlan": {...} }.${humanAnswers}

Source documents:
${sourceDocuments.map((document) => `--- ${document.path}\n${document.content}`).join('\n\n')}`,
                {
                  ...structuredNoToolOptions,
                  abortSignal,
                  requestContext: createDeliveryRequestContext(inputData.repoPath),
                  structuredOutput: {
                    schema: plannerOutputSchema,
                    ...deliveryStructuredOutputOptions,
                    instructions: 'Return only the structured readout and taskPlan objects.',
                  },
                },
              ),
          }),
          'planner',
        );
    output.taskPlan = normalizeTaskPlanForDelivery(inputData.repoPath, output.taskPlan);

    if (cachedOutput) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'planner_cache_reused',
          stage: 'plan',
          cache_validated: cachedOutput.cacheValidated,
        },
      });
    } else {
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/readout.json',
        artifact: output.readout,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/task-plan.json',
        artifact: output.taskPlan,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/plan-cache.json',
        artifact: {
          sourceFingerprint,
          policyVersion: plannerPolicyVersion,
          createdAt: new Date().toISOString(),
        },
      });
    }

    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'readout',
      path: '.delivery/artifacts/readout.json',
      mastra,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'task-plan',
      path: '.delivery/artifacts/task-plan.json',
      mastra,
    });

    const suspendForQuestions = shouldSuspendForPlannerQuestions(output.readout, output.taskPlan);
    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      reason: suspendForQuestions ? 'escalation' : 'complete_stage',
      mastra,
    });

    if (output.readout.blocking_ambiguities.length) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: suspendForQuestions ? 'human_input_required' : 'planning_questions_deferred',
          stage: 'plan',
          questions: output.readout.blocking_ambiguities,
        },
      });
    }

    if (suspendForQuestions) {
      await syncDeliveryWorkflowState({
        state,
        setState,
        output: {
          repoPath: inputData.repoPath,
          runId: inputData.runId,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          status: 'blocked_on_questions',
          summary: output.readout.recommended_next_step,
          artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
          questions: output.readout.blocking_ambiguities,
          nextSteps: ['Answer the blocking questions, then resume delivery planning.'],
          taskPlan: output.taskPlan,
        },
      });

      return await suspend(
        {
          reason: 'Planner found blocking ambiguities that require human answers before plan judgment.',
          questions: output.readout.blocking_ambiguities,
          recommendedNextStep: output.readout.recommended_next_step,
          readoutPath: '.delivery/artifacts/readout.json',
          taskPlanPath: '.delivery/artifacts/task-plan.json',
        },
        { resumeLabel: 'answer-planner-questions' },
      );
    }

    const plannerOutput = {
      ...inputData,
      readout: output.readout,
      taskPlan: output.taskPlan,
      artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
    };
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath: plannerOutput.repoPath,
        runId: plannerOutput.runId,
        maxRetries: plannerOutput.maxRetries,
        deployMode: plannerOutput.deployMode,
        reviewMode: plannerOutput.reviewMode,
        artifacts: plannerOutput.artifacts,
        taskPlan: plannerOutput.taskPlan,
        questions: output.readout.blocking_ambiguities,
      },
    });

    return plannerOutput;
  },
});

const createPlanGateStep = createStep({
  id: 'judge-task-plan',
  description: 'Run deterministic plan gates and rubric judgment before architect handoff.',
  inputSchema: plannerArtifactsSchema,
  outputSchema: planStageOutputSchema,
  scorers: deliveryPlanStepScorers,
  execute: async ({ inputData, mastra }) => {
    const deterministicResults = taskPlanDeterministicResults({
      repoPath: inputData.repoPath,
      taskPlan: inputData.taskPlan,
    });
    const checks = checkSummaries(deterministicResults);
    const taskPlanJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'task-plan',
      subjectName: '.delivery/artifacts/task-plan.json',
      subject: inputData.taskPlan,
      deterministicResults,
      slug: 'task-plan',
    });
    const taskPlanJudgment = taskPlanJudge.judgment;
    const artifacts = [
      ...inputData.artifacts,
      taskPlanJudge.judgeOutputPath,
      taskPlanJudge.judgmentPath,
    ];
    const judgments = [taskPlanJudge.ref];
    const planContext = {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
    };

    if (shouldSuspendForPlannerQuestions(inputData.readout, inputData.taskPlan)) {
      return {
        ...planContext,
        status: 'blocked_on_questions' as const,
        runId: inputData.runId,
        summary: inputData.readout.recommended_next_step,
        artifacts,
        checks,
        judgments,
        questions: inputData.readout.blocking_ambiguities,
        nextSteps: ['Answer the blocking questions, then rerun or resume delivery planning.'],
      };
    }

    if (checks.some((check) => !check.passed)) {
      return {
        ...planContext,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner produced artifacts, but deterministic plan checks failed.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: checks.filter((check) => !check.passed).map((check) => check.reason),
      };
    }

    if (!taskPlanJudgment.passed) {
      return {
        ...planContext,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner produced artifacts, but the task-plan rubric judgment failed.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: taskPlanJudgment.remediation,
      };
    }

    return {
      ...planContext,
      status: 'planned' as const,
      runId: inputData.runId,
      summary: inputData.taskPlan.scope,
      artifacts,
      checks,
      judgments,
      questions: inputData.readout.blocking_ambiguities,
      nextSteps: [
        ...inputData.readout.blocking_ambiguities.map((question) => `Deferred question: ${question}`),
        'Run architecture review against .delivery/artifacts/task-plan.json.',
        'Continue through the native architect review, build, release-gate, and deployment stages.',
      ],
    };
  },
});

const prepareReviewLoopStep = createStep({
  id: 'prepare-review-loop',
  description: 'Prepare architect review retry state for the native workflow loop.',
  inputSchema: planStageOutputSchema,
  outputSchema: reviewLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: true,
    });

    if (inputData.status !== 'planned') return passThrough();
    if (!inputData.taskPlan) throw new Error('plan stage did not provide a task plan for architect review');
    if (inputData.reviewMode === 'fast') {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'review_skipped',
          stage: 'review:fast',
          reason: 'Fast review mode: task plan passed deterministic and rubric gates; architect loop is available with reviewMode=thorough.',
        },
      });

      return {
        ...passThrough(),
        status: 'reviewed' as const,
        summary: `${inputData.summary} Fast review mode accepted the scored task plan for implementation.`,
        nextSteps: ['Run the delivery build loop against the scored task plan.'],
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: false,
    };
  },
});

const executeReviewAttemptStep = createStep({
  id: 'architect-review-attempt',
  description: 'Run one architect review attempt and optionally revise the task plan before the next loop iteration.',
  inputSchema: reviewLoopStateSchema,
  outputSchema: reviewLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal || inputData.status !== 'planned') {
      return { ...inputData, terminal: true };
    }
    if (!inputData.taskPlan) throw new Error('review loop did not provide a task plan for architect review');

    const architect = requiredAgent(mastra, 'architect');
    const planner = requiredAgent(mastra, 'planner');
    const taskPlan = inputData.taskPlan;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const attempt = inputData.attempt;
    const stageContext = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
    });

    const suffix = attempt === 0 ? 'initial' : `retry-${attempt}`;
    const reviewPath =
      attempt === 0 ? '.delivery/artifacts/review-report.json' : `.delivery/artifacts/review-report.${suffix}.json`;

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `review:${suffix}`,
      role: 'architect',
      mastra,
    });

    const reviewResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage: `review:${suffix}`,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        architect.generate(
          `Review the task plan below for structural readiness before implementation.

Evaluate granularity, error handling, trust boundaries, state authority, fail-fast behavior, data flow, security, and complexity.
Approve only when build can safely begin. Block when planner changes are required before implementation.
Use verdict "blocked" when any high-severity finding, auth/state-integrity finding, missing owner, or dependency defect must be fixed before implementation begins.
Every finding must be specific, evidenced, and remediable by an owning role.
Return exactly one JSON object, not a bare findings array, with this shape:
{
  "artifact_type": "review-report",
  "verdict": "approved" | "approved_with_conditions" | "blocked",
  "findings": [{ "severity": "high" | "medium" | "low", "title": "...", "location": "...", "evidence": "...", "why_it_matters": "...", "required_remediation": "..." }],
  "conditions": [],
  "residual_risks": [],
  "recommended_next_step": "..."
}

Task plan:
${JSON.stringify(taskPlan, null, 2)}`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            requestContext: createDeliveryRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: reviewReportSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only one review-report object. Do not return a bare array.',
            },
          },
        ),
    });

    const parsedReview = parseReviewReportResponse(reviewResponse, 'architect review');
    const reviewReport = parsedReview.report;
    if (parsedReview.repairedFromBareFindings) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_repaired',
          stage: `review:${suffix}`,
          target: 'review-report',
          reason: parsedReview.repairReason,
        },
      });
    }
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: reviewPath,
      artifact: reviewReport,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: attempt === 0 ? 'review-report' : `review-report:${suffix}`,
      path: reviewPath,
      mastra,
    });
    artifacts.push(reviewPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `review:${suffix}`,
      reason: reviewReport.verdict === 'blocked' ? 'escalation' : 'complete_stage',
      mastra,
    });

    const reviewJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'review-report',
      subjectName: reviewPath,
      subject: reviewReport,
      slug: attempt === 0 ? 'review-report' : `review-report-${suffix}`,
    });
    artifacts.push(reviewJudge.judgeOutputPath, reviewJudge.judgmentPath);
    judgments.push(reviewJudge.ref);

    const reviewNeedsRevision = reviewReport.verdict === 'blocked' || !reviewJudge.judgment.passed;
    const revisionRemediation = reviewJudge.judgment.passed
      ? reviewReport.findings.map(
          (finding) => `${finding.severity.toUpperCase()}: ${finding.title} - ${finding.required_remediation}`,
        )
      : reviewJudge.judgment.remediation;

    if (!reviewNeedsRevision) {
      return {
        ...stageContext(),
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Architect ${reviewReport.verdict}: ${reviewReport.recommended_next_step}`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: [
          ...reviewReport.conditions.map((condition) => `Condition: ${condition}`),
          ...reviewReport.residual_risks.map((risk) => `Watch: ${risk}`),
          'Run the delivery build loop against the approved task plan.',
        ],
        attempt,
        terminal: true,
      };
    }

    if (attempt >= inputData.maxRetries) {
      return {
        ...stageContext(),
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: !reviewJudge.judgment.passed
          ? 'Architect review report failed rubric judgment after bounded planner retries.'
          : 'Architect review blocked the plan after bounded planner retries.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: [reviewReport.recommended_next_step, ...revisionRemediation],
        attempt,
        terminal: true,
      };
    }

    const revisionNumber = attempt + 1;
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `plan:architect-bounce-${revisionNumber}`,
      role: 'planner',
      mastra,
    });

    const revisionResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage: `plan:architect-bounce-${revisionNumber}`,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        planner.generate(
          `The architect blocked the task plan. Revise the task plan to address the review findings.

Return a full replacement taskPlan object. Preserve concrete deliverables, checkable acceptance criteria, dependencies, and owned surfaces.
Do not write implementation code.
Every taskPlan.tasks[].owned_surfaces entry must be a concrete repo path, not a conceptual label or wildcard. Use "unknown: <why>" only when the file truly cannot be known.
Keep taskPlan.open_decisions limited to genuine blockers only. Non-blocking unknowns belong in risks. Safe defaults belong in the readout on the next full planning pass, so do not add them to taskPlan.open_decisions here.
Every taskPlan.open_decisions entry must use this exact field shape:
"Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.

Current task plan:
${JSON.stringify(taskPlan, null, 2)}

Architect review:
${JSON.stringify(reviewReport, null, 2)}

Rubric remediation from the review judge:
${revisionRemediation.map((item) => `- ${item}`).join('\n')}`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            requestContext: createDeliveryRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: plannerRevisionOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
            },
          },
        ),
    });

    const parsedRevision = parsePlannerRevisionResponse(revisionResponse, 'planner revision');
    if (parsedRevision.repairedFromBareTaskPlan) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_repaired',
          stage: `plan:architect-bounce-${revisionNumber}`,
          target: 'task-plan',
          reason: parsedRevision.repairReason,
        },
      });
    }
    const revision = parsedRevision.revision;
    const revisedTaskPlan = normalizeTaskPlanForDelivery(inputData.repoPath, revision.taskPlan);
    const revisionPath = `.delivery/artifacts/task-plan.revision-${revisionNumber}.json`;
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: revisionPath,
      artifact: revisedTaskPlan,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `task-plan:revision-${revisionNumber}`,
      path: revisionPath,
      mastra,
    });
    artifacts.push(revisionPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: `plan:architect-bounce-${revisionNumber}`,
      reason: 'complete_stage',
      mastra,
    });

    const revisedDeterministicResults = taskPlanDeterministicResults({
      repoPath: inputData.repoPath,
      taskPlan: revisedTaskPlan,
    });
    checks.push(...checkSummaries(revisedDeterministicResults, `revision-${revisionNumber}`));
    const failedRevisedChecks = revisedDeterministicResults.filter((check) => !check.passed);
    if (failedRevisedChecks.length) {
      return {
        ...stageContext(),
        taskPlan: revisedTaskPlan,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner revision failed deterministic task-plan gates.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: failedRevisedChecks.map((check) => check.reason ?? 'deterministic check failed'),
        attempt,
        terminal: true,
      };
    }

    const revisedPlanJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'task-plan',
      subjectName: revisionPath,
      subject: revisedTaskPlan,
      deterministicResults: revisedDeterministicResults,
      slug: `task-plan-revision-${revisionNumber}`,
    });
    artifacts.push(revisedPlanJudge.judgeOutputPath, revisedPlanJudge.judgmentPath);
    judgments.push(revisedPlanJudge.ref);

    if (!revisedPlanJudge.judgment.passed) {
      return {
        ...stageContext(),
        taskPlan: revisedTaskPlan,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner revision failed task-plan rubric judgment.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: revisedPlanJudge.judgment.remediation,
        attempt,
        terminal: true,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan: revisedTaskPlan,
      releaseGate: inputData.releaseGate,
      status: 'reviewed' as const,
      runId: inputData.runId,
      summary: 'Planner revised the task plan after architect review; revised plan passed judgment.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Run the delivery build loop against the revised task plan.'],
      attempt: revisionNumber,
      terminal: true,
    };
  },
});

const finalizeReviewLoopStep = createStep({
  id: 'architect-review',
  description: 'Finalize architect review loop output for delivery workflow handoff.',
  inputSchema: reviewLoopStateSchema,
  outputSchema: deliveryStageOutputSchema,
  scorers: deliveryReviewStepScorers,
  execute: async ({ inputData }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    reviewMode: inputData.reviewMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    status: inputData.status,
    runId: inputData.runId,
    summary: inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps: inputData.nextSteps,
  }),
});

const prepareBuildTasksStep = createStep({
  id: 'prepare-build-tasks',
  description: 'Expand the reviewed task plan into workflow-native build work items.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: buildTaskWorkItemsSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      taskIndex: 0,
      skipped: true,
    });

    if (inputData.status !== 'reviewed') return [passThrough()];
    if (!inputData.taskPlan) throw new Error('review stage did not provide a task plan for the build loop');

    const orderedTasks = topoOrderTasks(inputData.taskPlan.tasks);
    if (!orderedTasks.length) {
      return [
        {
          ...passThrough(),
          status: 'built' as const,
          summary: 'Build loop completed: no implementation tasks were present.',
          nextSteps: ['Run the release gate stage against the reviewed task plan.'],
        },
      ];
    }

    const resumePlan = deliveryBuildResumePlan(inputData.repoPath, inputData.taskPlan);
    const resumeReason = deliveryBuildResumeReason(resumePlan);
    const checks = resumeReason
      ? [...inputData.checks, { check: 'build_resume_cursor', passed: true, reason: resumeReason }]
      : inputData.checks;

    if (resumeReason) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'build_resume_cursor',
          stage: 'build',
          ok: true,
          reusable_task_ids: resumePlan.reusableTaskIds,
          resume_after_task: resumePlan.resumeAfterTaskId,
          next_task: resumePlan.nextTaskId,
          total_tasks: resumePlan.totalTasks,
        },
      }).catch(() => undefined);
    }

    return orderedTasks.map((task, taskIndex) => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      task,
      taskIndex,
      skipped: false,
    }));
  },
});

const prepareBuildTaskAttemptLoopStep = createStep({
  id: 'prepare-build-task-attempt-loop',
  description: 'Prepare one build task for native retry attempts.',
  inputSchema: buildTaskWorkItemSchema,
  outputSchema: buildTaskAttemptStateSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = (taskStatus: 'complete' | 'stuck' | 'blocked' | 'skipped' = 'skipped') => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      taskId: inputData.task?.id,
      taskStatus,
      attempt: 0,
      terminal: true,
      remediation: [],
    });

    if (inputData.skipped) return passThrough();
    if (inputData.status !== 'reviewed') return passThrough();
    if (!inputData.taskPlan) throw new Error('review stage did not provide a task plan for the build task');
    if (!inputData.task) throw new Error('build task work item did not include a task');

    const taskPlan = inputData.taskPlan;
    const task = inputData.task;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];

    const run = await readDeliveryRunState({ repoPath: inputData.repoPath, mastra });
    const priorStopped = priorStoppedBuildTaskIds({
      taskPlan,
      taskIndex: inputData.taskIndex,
      taskStatuses: run.tasks,
    });
    if (priorStopped.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'blocked',
        owner: task.owner,
        note: `paused by earlier stopped task ${priorStopped.join(', ')}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} paused because earlier build tasks stopped.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: priorStopped.map((dependency) => `${task.id} paused by earlier stopped task ${dependency}`),
        taskId: task.id,
        taskStatus: 'blocked' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    const blockedBy = task.depends_on.filter((dependency) => run.tasks[dependency]?.status !== 'complete');
    if (blockedBy.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'blocked',
        owner: task.owner,
        note: `blocked by dependency ${blockedBy.join(', ')}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} blocked by dependencies.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: blockedBy.map((dependency) => `${task.id} blocked by ${dependency}`),
        taskId: task.id,
        taskStatus: 'blocked' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    const reusable = reusableImplementationArtifactForTask(inputData.repoPath, task);
    if (reusable) {
      const judgmentRef: JudgmentRef = {
        subject: reusable.notePath,
        rubric: reusable.judgment.rubric ?? 'implementation',
        path: reusable.judgmentPath,
        overall: reusable.judgment.overall ?? 0,
        passed: true,
      };
      const reusedArtifacts = [
        reusable.notePath,
        reusable.judgmentPath,
        ...(reusable.judgeOutputPath ? [reusable.judgeOutputPath] : []),
      ];
      artifacts.push(...reusedArtifacts);
      checks.push({
        check: `reused_implementation_artifact:${task.id}`,
        passed: true,
        reason: `Reused passing implementation judgment ${reusable.judgmentPath} after owned surfaces were present.`,
      });
      judgments.push(judgmentRef);

      await recordDeliveryArtifactState({
        repoPath: inputData.repoPath,
        type: `note-${task.id}`,
        path: reusable.notePath,
        mastra,
      });
      await recordDeliveryJudgmentState({
        repoPath: inputData.repoPath,
        subject: reusable.notePath,
        rubric: judgmentRef.rubric,
        path: judgmentRef.path,
        overall: judgmentRef.overall,
        passed: judgmentRef.passed,
        mastra,
      });
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'implementation_artifact_reused',
          stage: `build:${task.id}`,
          ok: true,
          task: task.id,
          attempt: reusable.attempt,
          notePath: reusable.notePath,
          judgmentPath: reusable.judgmentPath,
        },
      });
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'complete',
        owner: task.owner,
        note: `reused passing judgment ${reusable.judgment.overall}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'built' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} reused a prior passing implementation artifact.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: ['Continue the delivery build loop.'],
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'complete' as const,
        attempt: 0,
        terminal: true,
        remediation: [],
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts,
      checks,
      judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      task,
      taskIndex: inputData.taskIndex,
      skipped: false,
      taskId: task.id,
      taskStatus: undefined,
      attempt: 0,
      terminal: false,
      remediation: [],
    };
  },
});

const executeBuildTaskAttemptStep = createStep({
  id: 'execute-build-task-attempt',
  description: 'Run one implementation attempt for a build task and decide whether another attempt is needed.',
  inputSchema: buildTaskAttemptStateSchema,
  outputSchema: buildTaskAttemptStateSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal) return inputData;
    if (!inputData.taskPlan) throw new Error('build task attempt did not include a task plan');
    if (!inputData.task) throw new Error('build task attempt did not include a task');

    const taskPlan = inputData.taskPlan;
    const task = inputData.task;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const role = buildRoleForTask(task);
    const agent = requiredAgent(mastra, role);
    const attempt = inputData.attempt;
    const attemptNumber = attempt + 1;
    const stage = `build:${task.id}`;
    const usableSurfaces = taskBoundarySurfaces(inputData.repoPath, task).filter((surface) => !/^unknown\b/i.test(surface));
    await updateDeliveryTaskState({
      repoPath: inputData.repoPath,
      id: task.id,
      status: 'building',
      owner: role,
      note: attempt > 0 ? `retry ${attemptNumber}` : undefined,
      bumpRetries: attempt > 0,
      mastra,
    });
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role,
      surfaces: usableSurfaces.length ? usableSurfaces : undefined,
      mastra,
    });

    const preflightCreatedSurfaces = await createMissingOwnedSurfaceStubs({
      repoPath: inputData.repoPath,
      task,
      stage,
      mastra,
    });
    const missingSurfaces = missingOwnedSurfacePaths(inputData.repoPath, task);
    const unreplacedStubs = unreplacedPreflightStubPaths(inputData.repoPath, task);
    const verificationRecovery = remediationHasVerificationFailure(inputData.remediation);
    const retryMode = implementationRetryMode({
      remediation: inputData.remediation,
      missingSurfaces,
      unreplacedStubs,
    });
    const failureClass = implementationFailureClass(inputData.remediation);
    const writeFirstRecovery = retryMode === 'write-first';
    const replaceStubsRecovery = retryMode === 'replace-stubs';
    const focusedRepairRecovery = retryMode === 'focused-repair';
    const activeTools = writeFirstRecovery
      ? implementationWriteOnlyWorkspaceTools
      : replaceStubsRecovery || focusedRepairRecovery
        ? implementationRepairWorkspaceTools
        : implementationWorkspaceTools;
    const toolChoice = implementationToolChoiceForRetryMode(retryMode);
    const maxSteps = writeFirstRecovery ? 3 : replaceStubsRecovery ? 5 : focusedRepairRecovery ? 4 : 8;
    const packageManifestOwned = taskOwnsPackageManifest(task);
    const existingPackageDependencies = packageDependencyNames(inputData.repoPath);
    const dependencySurfaces = directDependencySurfacePaths(taskPlan, task);
    const focusedRepairFileContext = replaceStubsRecovery || focusedRepairRecovery
      ? repoFileContents(inputData.repoPath, focusedRepairContextPaths(taskPlan, task, usableSurfaces))
      : [];
    const taskPacket = {
      scope: taskPlan.scope,
      task,
      technology_decisions: taskPlan.technology_decisions,
      open_decisions: taskPlan.open_decisions,
      risks: taskPlan.risks,
      remediation: inputData.remediation,
      failure_class: failureClass,
      missing_owned_surfaces: missingSurfaces,
      unreplaced_preflight_stubs: unreplacedStubs,
      preflight_created_surfaces: preflightCreatedSurfaces,
      boundary_surfaces: usableSurfaces,
      direct_dependency_surfaces: dependencySurfaces,
      package_manifest_owned: packageManifestOwned,
      existing_package_dependencies: existingPackageDependencies,
      focused_repair_file_context: focusedRepairFileContext,
      platform_policy_findings: workersAiBindingGaps(inputData.repoPath, task),
    };

    const buildPrompt = `Implement build task ${task.id}.

Use this task packet as the source of truth. Do not reread .delivery planning or review artifacts unless a specific required field is missing from the packet.

Task packet:
${JSON.stringify(taskPacket, null, 2)}

Execution rules:
- Make the smallest coherent code change for this task.
- Touch only the boundary surfaces in the task packet unless a dependency blocks the task.
- If preflight_created_surfaces is non-empty, replace those stubs with the real implementation for this task.
- If an owned surface is still missing, create it.
- If unreplaced_preflight_stubs is non-empty, replace every listed stub before editing any other file.
- Spend at most one quick list/read pass on the existing repo shape before writing files.
- For schema/storage/route tasks, read the relevant direct_dependency_surfaces before writing when they define or consume shared domain contracts.
- Keep domain values aligned across validation, D1 schema, repository modules, and route adapters; profile kind values are not the same thing as R2 artifact object categories.
- direct_dependency_surfaces are read-only context unless a listed path is also present in boundary_surfaces.
- Do not run shell commands; the workflow runs verification after your edits.
- If this is a retry, edit the files needed to resolve the remediation before doing any broad investigation.
- In write-first or focused repair mode, you must call an available workspace write/edit tool before returning; a text-only response is a failed attempt.
- If failure_class is missing_surface, create every missing_owned_surface before editing any other file.
- If failure_class is preflight_stub, replace every unreplaced_preflight_stub before editing any other file.
- If failure_class is policy_boundary, do not repeat blocked writes; use only normalized boundary_surfaces paths.
- Do not introduce runtime dependencies that are absent from existing_package_dependencies unless package_manifest_owned is true and you update the package manifest in this task.
- If verification says a module cannot be found, prefer the existing Worker/router pattern or native Web/Cloudflare APIs over adding a new dependency.
- Treat platform_policy_findings as mandatory corrections, even when the original task text is stale.
- For lifecycle/status storage, make state explicit: constrained status values, timestamps, query indexes, and failed/stuck states when the lifecycle can fail. Schema tasks must encode this in D1 CHECK constraints and indexes, not only TypeScript constants.
- For route tasks, integrate new endpoints through the existing Worker router/barrel/middleware path. Do not import route handlers into src/index.ts and dispatch them before routeRequest when routeRequest already exists.
- If failure_class is judge_timeout, preserve working code and make only the smallest evidence-improving or obvious correctness edit before the workflow retries judgment.
- Do not inspect node_modules; rely on project types and workflow verification.
- If timeout recovery is active, do not investigate. Create the missing owned surfaces immediately.
- Return a brief natural-language summary; the workflow will create the implementation note from files, events, and verification.`;
    const recoveryPrompt = writeFirstRecovery
      ? `

Timeout recovery is active.
- Missing owned surfaces: ${missingSurfaces.join(', ')}
- Use only write/mkdir tools.
- The tool choice is required; call the workspace write tool now.
- Do not read or list files in this attempt.
- Create compile-safe placeholders that satisfy the task packet and allow workflow verification to run.`
      : '';
    const replaceStubsPrompt = replaceStubsRecovery
      ? `

Preflight stub replacement mode is active.
- Replace every unreplaced_preflight_stub before doing anything else:
${unreplacedStubs.map((item) => `  - ${item}`).join('\n') || '  - none'}
- Use mastra_workspace_write_file or mastra_workspace_edit_file now; a text-only response is a failed attempt.
- Do not list or read files in this attempt.
- Use focused_repair_file_context as your source for current file contents and dependency context.
- Prefer one write/edit per listed stub path, and do not return until every listed stub has real compile-safe implementation code.
- Do not edit dependency context files unless they also appear in boundary_surfaces.`
      : '';
    const repairPrompt = focusedRepairRecovery
      ? `

Focused repair mode is active.
- Fix the remediation below before doing anything else:
${inputData.remediation.map((item) => `  - ${item}`).join('\n')}
- If unreplaced_preflight_stubs is non-empty, replace every listed stub before doing anything else:
${unreplacedStubs.map((item) => `  - ${item}`).join('\n') || '  - none'}
- Use focused_repair_file_context as your source for current file contents. It includes boundary files plus direct dependency files needed for type and domain contracts.
- Do not list or read files in this attempt.
- The tool choice is required; call mastra_workspace_edit_file or mastra_workspace_write_file now.
- Prefer editing existing generated files over adding new files.
- Do not edit dependency context files unless they also appear in boundary_surfaces.
- Do not read spec.md, wrangler.toml, package.json, or package-lock.json unless that exact file is listed in boundary_surfaces.
- Do not add or import a package that is not already listed in existing_package_dependencies unless package_manifest_owned is true.`
      : '';
    const finalBuildPrompt = `${buildPrompt}${recoveryPrompt}${replaceStubsPrompt}${repairPrompt}`;
    let buildResponse: unknown;
    try {
      buildResponse = await runWithDeliveryStageTimeout({
        repoPath: inputData.repoPath,
        mastra,
        stage,
        timeoutMs: deliveryAgentTimeouts.build,
        firstToolTimeoutMs: deliveryAgentTimeouts.buildNoTool,
        firstToolCheck: () => stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage }),
        postWriteQuietTimeoutMs: deliveryAgentTimeouts.buildPostWriteQuiet,
        latestWriteCheck: () => latestStageSuccessfulWriteTimestamp({ repoPath: inputData.repoPath, mastra, stage }),
        operation: (abortSignal) =>
          agent.generate(
            finalBuildPrompt,
            {
              abortSignal,
              activeTools,
              toolChoice,
              maxSteps,
              toolCallConcurrency: 1,
              requestContext: createDeliveryRequestContext(inputData.repoPath),
            },
          ),
      });
    } catch (error) {
      if (!(error instanceof DeliveryStageTimeoutError)) throw error;

      const missingSurfacesAfterTimeout = missingOwnedSurfacePaths(inputData.repoPath, task);
      const unreplacedStubsAfterTimeout = unreplacedPreflightStubPaths(inputData.repoPath, task);
      const stageHadToolUse = await stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage });
      if (
        canSalvageTimedOutBuildAttempt({
          stageHadToolUse,
          missingSurfaces: missingSurfacesAfterTimeout,
          unreplacedStubs: unreplacedStubsAfterTimeout,
        })
      ) {
        await appendDeliveryEventState({
          repoPath: inputData.repoPath,
          mastra,
          event: {
            type: 'build_timeout_salvaged',
            stage,
            ok: true,
            task: task.id,
            attempt: attemptNumber,
            timeout_ms: error.timeoutMs,
            reason:
              'Build attempt timed out after file edits, but owned surfaces are present and preflight stubs are replaced; running workflow verification instead of marking stuck.',
          },
        });
        await startDeliveryStageState({
          repoPath: inputData.repoPath,
          stage,
          role,
          surfaces: usableSurfaces.length ? usableSurfaces : undefined,
          mastra,
        });
        buildResponse = {
          text: `Build attempt timed out after ${error.timeoutMs}ms after making file changes; workflow recovered by running verification against the edited boundary surfaces.`,
          finishReason: 'timeout-salvaged',
        };
      } else {
      const remediation = buildTimeoutRemediation({
        task,
        timeoutMs: error.timeoutMs,
        missingSurfaces: missingSurfacesAfterTimeout,
        repairRecovery: focusedRepairRecovery || verificationRecovery,
        noToolCall: error instanceof DeliveryNoToolCallTimeoutError,
        priorRemediation: inputData.remediation,
      });
      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
          mastra,
        });

        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} timed out.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'building',
        owner: role,
        note: `retry after timeout ${attemptNumber}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} timed out and needs another implementation attempt.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
      }
    }
    const buildTracePath = await writeStageTraceArtifact({
      repoPath: inputData.repoPath,
      mastra,
      artifactType: `trace-build-${task.id}-a${attemptNumber}`,
      artifactPath: `.delivery/artifacts/traces/build-${task.id}-a${attemptNumber}.json`,
      trace: {
        artifact_type: 'agent-turn-trace',
        stage,
        role,
        task: task.id,
        attempt: attemptNumber,
        prompt: finalBuildPrompt,
        response: serializeAgentResponse(buildResponse),
        activeTools,
        toolChoice,
        retryMode,
      },
    });
    artifacts.push(buildTracePath);

    const verification = await runBuildVerification({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      taskPlan,
      taskIndex: inputData.taskIndex,
    });
    const buildEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const note = synthesizeImplementationNote({
      repoPath: inputData.repoPath,
      stage,
      task,
      taskPlan,
      events: buildEvents,
      buildResponse,
      verification,
    });
    const notePath = `.delivery/artifacts/note-${task.id}.a${attemptNumber}.json`;
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: notePath,
      artifact: note,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `note-${task.id}`,
      path: notePath,
      mastra,
    });
    artifacts.push(notePath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = implementationDeterministicResults({
      repoPath: inputData.repoPath,
      stage,
      role,
      task,
      note,
      events: deliveryEvents,
      verification,
    });
    checks.push(...checkSummaries(deterministicResults, `${task.id}.a${attemptNumber}`));

    const deterministicRemediation = implementationDeterministicRemediation(deterministicResults);
    if (deterministicRemediation.length) {
      const enginePolicyMismatch = implementationEnginePolicyMismatch({
        repoPath: inputData.repoPath,
        stage,
        role,
        task,
        events: deliveryEvents,
      });
      const staleWorkspaceVerification = deterministicRemediation.filter((item) =>
        /\bSTALE_WORKSPACE_VERIFICATION\b/i.test(item),
      );
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'implementation_deterministic_blocker',
          stage,
          ok: false,
          task: task.id,
          attempt: attemptNumber,
          remediation: deterministicRemediation,
          engine_policy_mismatch: enginePolicyMismatch,
        },
      });

      if (staleWorkspaceVerification.length) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: staleWorkspaceVerification.join(' | ').slice(0, 300),
          mastra,
        });

        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} stopped because repo-wide verification failed outside the current task plan.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: staleWorkspaceVerification,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation: staleWorkspaceVerification,
        };
      }

      if (enginePolicyMismatch.length) {
        const remediation = [...enginePolicyMismatch, ...deterministicRemediation];
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
          mastra,
        });

        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} stopped on a delivery engine policy mismatch.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: deterministicRemediation.join(' | ').slice(0, 300),
          mastra,
        });

        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} failed deterministic implementation gates.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: deterministicRemediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation: deterministicRemediation,
        };
      }

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} needs another attempt after deterministic implementation gates.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: deterministicRemediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation: deterministicRemediation,
      };
    }

    let implementationJudge: Awaited<ReturnType<typeof judgeDeliveryArtifact>>;
    try {
      implementationJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        rubricName: 'implementation',
        subjectName: notePath,
        subject: {
          task,
          note,
          files: repoFileContents(inputData.repoPath, note.files_touched),
          task_plan: taskPlan,
        },
        deterministicResults,
        slug: `implementation-${task.id}-a${attemptNumber}`,
      });
    } catch (error) {
      if (!(error instanceof DeliveryStageTimeoutError)) throw error;

      const remediation = implementationJudgeTimeoutRemediation(task.id, attemptNumber, error.timeoutMs);
      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
          mastra,
        });

        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} judgment timed out.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
          taskId: task.id,
          taskStatus: 'stuck' as const,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          attempt,
          terminal: true,
          remediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'building',
        owner: role,
        note: `retry after judge timeout ${attemptNumber}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'reviewed' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} judgment timed out and needs another bounded attempt.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
    }
    artifacts.push(implementationJudge.judgeOutputPath, implementationJudge.judgmentPath, implementationJudge.tracePath);
    judgments.push(implementationJudge.ref);

    if (
      implementationJudgmentCanComplete({
        judgment: implementationJudge.judgment,
        deterministicResults,
        note,
        task,
      })
    ) {
      const acceptedByFastPath = !implementationJudge.judgment.passed;
      if (acceptedByFastPath) {
        const check = {
          check: `non_actionable_implementation_judgment:${task.id}.a${attemptNumber}`,
          passed: true,
          reason: `Implementation judgment scored ${implementationJudge.judgment.overall} without failed gates, failed deterministic checks, or actionable remediation.`,
        };
        checks.push(check);
        await appendDeliveryEventState({
          repoPath: inputData.repoPath,
          mastra,
          event: {
            type: 'implementation_judgment_non_actionable',
            stage,
            ok: true,
            task: task.id,
            attempt: attemptNumber,
            overall: implementationJudge.judgment.overall,
            judgmentPath: implementationJudge.judgmentPath,
          },
        });
      }
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'complete',
        owner: role,
        note: acceptedByFastPath
          ? `accepted non-actionable judgment ${implementationJudge.judgment.overall}`
          : `judged ${implementationJudge.judgment.overall}`,
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'built' as const,
        runId: inputData.runId,
        summary: acceptedByFastPath
          ? `Build task ${task.id} completed with a non-actionable implementation score recorded for release-gate follow-up.`
          : `Build task ${task.id} completed.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: acceptedByFastPath
          ? ['Continue the delivery build loop; release gate should verify any missing acceptance checks.']
          : ['Continue the delivery build loop.'],
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        taskId: task.id,
        taskStatus: 'complete' as const,
        attempt,
        terminal: true,
        remediation: [],
      };
    }

    const remediation = implementationFindingSteps(task.id, implementationJudge.judgment, task);
    if (attempt >= inputData.maxRetries) {
      if (!judgeRepairAlreadyAttempted(inputData.remediation)) {
        const judgeRepairRemediation = implementationJudgeRepairRemediation(
          implementationJudge.judgmentPath,
          remediation,
        );
        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan,
          releaseGate: inputData.releaseGate,
          status: 'reviewed' as const,
          runId: inputData.runId,
          summary: `Build task ${task.id} passed deterministic checks and needs one focused judge repair attempt.`,
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: judgeRepairRemediation,
          task,
          taskIndex: inputData.taskIndex,
          skipped: false,
          taskId: task.id,
          taskStatus: undefined,
          attempt: attempt + 1,
          terminal: false,
          remediation: judgeRepairRemediation,
        };
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: remediation.join(' | ').slice(0, 300) || 'implementation did not pass judgment',
        mastra,
      });

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan,
        releaseGate: inputData.releaseGate,
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: `Build task ${task.id} did not pass implementation judgment.`,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation,
        taskId: task.id,
        taskStatus: 'stuck' as const,
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
        attempt,
        terminal: true,
        remediation,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan,
      releaseGate: inputData.releaseGate,
      status: 'reviewed' as const,
      runId: inputData.runId,
      summary: `Build task ${task.id} needs another implementation attempt.`,
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: remediation,
      task,
      taskIndex: inputData.taskIndex,
      skipped: false,
      taskId: task.id,
      taskStatus: undefined,
      attempt: attempt + 1,
      terminal: false,
      remediation,
    };
  },
});

const finalizeBuildTaskAttemptLoopStep = createStep({
  id: 'execute-build-task',
  description: 'Finalize native build task attempt loop output.',
  inputSchema: buildTaskAttemptStateSchema,
  outputSchema: buildTaskResultSchema,
  execute: async ({ inputData }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    status: inputData.status === 'reviewed' ? ('stuck' as const) : inputData.status,
    runId: inputData.runId,
    summary:
      inputData.status === 'reviewed' ? 'Build task attempt loop ended before a terminal result.' : inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps:
      inputData.status === 'reviewed'
        ? inputData.remediation.length
          ? inputData.remediation
          : ['Inspect build task attempt state and rerun the build loop.']
        : inputData.nextSteps,
    taskId: inputData.taskId,
    taskStatus: inputData.taskStatus ?? (inputData.status === 'reviewed' ? ('stuck' as const) : undefined),
  }),
});

export const deliveryBuildTaskWorkflow = createWorkflow({
  id: 'delivery-build-task',
  description: 'Nested workflow that executes one implementation task with role boundary and judgment gates.',
  inputSchema: buildTaskWorkItemSchema,
  outputSchema: buildTaskResultSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(prepareBuildTaskAttemptLoopStep)
  .dountil(executeBuildTaskAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeBuildTaskAttemptLoopStep)
  .commit();

const aggregateBuildTaskResultsStep = createStep({
  id: 'delivery-build-loop',
  description: 'Aggregate workflow-native build task results into the delivery stage output.',
  inputSchema: buildTaskResultsSchema,
  outputSchema: deliveryStageOutputSchema,
  scorers: deliveryBuildStepScorers,
  execute: async ({ inputData }) => {
    const first = inputData[0];
    if (!first) throw new Error('build loop did not receive any task results');

    const uniqueArtifacts = Array.from(new Set(inputData.flatMap((result) => result.artifacts)));
    const checkKeys = new Set<string>();
    const checks = inputData
      .flatMap((result) => result.checks)
      .filter((check) => {
        const key = `${check.check}:${check.passed}:${check.reason}`;
        if (checkKeys.has(key)) return false;
        checkKeys.add(key);
        return true;
      });
    const judgmentKeys = new Set<string>();
    const judgments = inputData
      .flatMap((result) => result.judgments)
      .filter((judgment) => {
        if (judgmentKeys.has(judgment.path)) return false;
        judgmentKeys.add(judgment.path);
        return true;
      });
    const taskState = Object.fromEntries(
      inputData
        .filter((result) => result.taskId && result.taskStatus && result.taskStatus !== 'skipped')
        .map((result) => [result.taskId, result.taskStatus]),
    ) as Record<string, 'complete' | 'stuck' | 'blocked'>;

    const allSkipped = inputData.every((result) => result.taskStatus === 'skipped' || !result.taskId);
    if (allSkipped) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        status: first.status,
        runId: first.runId,
        summary: first.summary,
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: first.questions,
        nextSteps: first.nextSteps,
      };
    }

    const blockedOrStuck = Object.entries(taskState).filter(([, status]) => status !== 'complete');
    if (blockedOrStuck.length) {
      return {
        repoPath: first.repoPath,
        maxRetries: first.maxRetries,
        deployMode: first.deployMode,
        taskPlan: first.taskPlan,
        releaseGate: first.releaseGate,
        status: 'stuck' as const,
        runId: first.runId,
        summary: 'Build loop stopped with stuck or blocked tasks.',
        artifacts: uniqueArtifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: blockedOrStuck.map(([id, status]) => `${id}:${status}`),
      };
    }

    return {
      repoPath: first.repoPath,
      maxRetries: first.maxRetries,
      deployMode: first.deployMode,
      taskPlan: first.taskPlan,
      releaseGate: first.releaseGate,
      status: 'built' as const,
      runId: first.runId,
      summary: `Build loop completed: ${taskStatusSummary(taskState).join(', ')}`,
      artifacts: uniqueArtifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Run the release gate stage against implementation notes and changed code.'],
    };
  },
});

const prepareReleaseGateLoopStep = createStep({
  id: 'prepare-release-gate-loop',
  description: 'Prepare tester release gate retry state for the native workflow loop.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: releaseGateLoopStateSchema,
  execute: async ({ inputData }) => {
    const passThrough = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: true,
      remediation: [],
    });

    if (inputData.status !== 'built') return passThrough();
    if (!inputData.taskPlan) throw new Error('build stage did not provide a task plan for release gating');

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: inputData.releaseGate,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
      attempt: 0,
      terminal: false,
      remediation: [],
    };
  },
});

const executeReleaseGateAttemptStep = createStep({
  id: 'release-gate-attempt',
  description: 'Run one release gate attempt and decide whether another tester attempt is needed.',
  inputSchema: releaseGateLoopStateSchema,
  outputSchema: releaseGateLoopStateSchema,
  execute: async ({ inputData, mastra }) => {
    if (inputData.terminal || inputData.status !== 'built') {
      return { ...inputData, terminal: true };
    }
    if (!inputData.taskPlan) throw new Error('release gate loop did not provide a task plan');

    const tester = requiredAgent(mastra, 'tester');
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const attempt = inputData.attempt;
    const attemptNumber = attempt + 1;
    const stage = `test:a${attemptNumber}`;
    const gatePath =
      attempt === 0 ? '.delivery/artifacts/release-gate.json' : `.delivery/artifacts/release-gate.a${attemptNumber}.json`;
    const evidencePath = `.delivery/artifacts/test-evidence.a${attemptNumber}.json`;

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role: 'tester',
      mastra,
    });

    const evidence = await collectReleaseGateEvidence({
      repoPath: inputData.repoPath,
      mastra,
      stage,
    });
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: evidencePath,
      artifact: evidence,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: `test-evidence:a${attemptNumber}`,
      path: evidencePath,
      mastra,
    });
    artifacts.push(evidencePath);

    const evidenceEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const gateResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.build,
      operation: (abortSignal) =>
        tester.generate(
          `Synthesize a release gate for pre-deployment from the evidence below.

Do not call tools. Do not claim evidence that is not listed here.
Use decision "pass" only when all critical areas are verified or not_applicable and blockers is empty.
Use decision "fail" when any critical area is missing, any required evidence command failed, or any acceptance-critical behavior is unproven.
For event_type "pre_deployment", tiers must be "passed" when supported by evidence or "not_required" with a reason when no tier-specific harness exists. Use "failed" only for an evidence command that actually failed.

Known task plan:
${JSON.stringify(inputData.taskPlan, null, 2)}

Known implementation judgment refs:
${JSON.stringify(judgments.slice(-12), null, 2)}

Delivery artifacts:
${JSON.stringify(artifacts.slice(-24), null, 2)}

Evidence artifact path: ${evidencePath}
Evidence:
${JSON.stringify(evidence, null, 2)}

Stage events:
${JSON.stringify(evidenceEvents.filter((event) => event.stage === stage).slice(-30), null, 2)}

${inputData.remediation.length ? `This is a bounce. Fix exactly these release-gate findings:\n${inputData.remediation.map((item) => `- ${item}`).join('\n')}\n` : ''}
Return a release-gate object with event_type "pre_deployment". Every critical area must be verified with cited evidence, missing and therefore blocking, or not_applicable with a reason. Fail closed on unproven critical behavior.`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            requestContext: createDeliveryRequestContext(inputData.repoPath),
            structuredOutput: {
              schema: testerOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only { "gate": <release-gate> }.',
            },
          },
        ),
    });

    let gate: ReleaseGate;
    try {
      gate = parseDeliveryStructuredOutput(testerOutputSchema, gateResponse, 'tester release gate').gate;
    } catch (error) {
      gate = releaseGateForInvalidTesterOutput(error);
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'structured_output_invalid',
          stage,
          role: 'tester',
          ok: false,
          artifact_type: 'release-gate',
          path: gatePath,
          error: compactDiagnostic(error, 900),
        },
      });
    }

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: gatePath,
      artifact: gate,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: attempt === 0 ? 'release-gate' : `release-gate:a${attemptNumber}`,
      path: gatePath,
      mastra,
    });
    artifacts.push(gatePath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = releaseGateDeterministicResults({
      stage,
      gate,
      events: deliveryEvents,
    });
    checks.push(...checkSummaries(deterministicResults, `release-gate.a${attemptNumber}`));

    const gateJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'release-gate',
      subjectName: gatePath,
      subject: {
        gate,
        evidence_events: deliveryEvents.filter((event) => event.stage === stage),
      },
      deterministicResults,
      slug: `release-gate-a${attemptNumber}`,
    });
    artifacts.push(gateJudge.judgeOutputPath, gateJudge.judgmentPath);
    judgments.push(gateJudge.ref);

    if (gateJudge.judgment.passed) {
      if (gate.decision !== 'pass') {
        return {
          repoPath: inputData.repoPath,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          taskPlan: inputData.taskPlan,
          releaseGate: gate,
          status: 'gate_failed' as const,
          runId: inputData.runId,
          summary: 'Release gate failed; deployment is stopped.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: gate.blockers.length ? gate.blockers : ['Fix release-gate blockers and rerun test stage.'],
          attempt,
          terminal: true,
          remediation: [],
        };
      }

      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan: inputData.taskPlan,
        releaseGate: gate,
        status: 'release_ready' as const,
        runId: inputData.runId,
        summary: gate.summary,
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: ['Run deployment stage using the passing release gate.'],
        attempt,
        terminal: true,
        remediation: [],
      };
    }

    const remediation = gateJudge.judgment.remediation;
    if (attempt < inputData.maxRetries) {
      return {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        taskPlan: inputData.taskPlan,
        releaseGate: gate,
        status: 'built' as const,
        runId: inputData.runId,
        summary: 'Release gate needs another tester attempt.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: remediation.length ? remediation : ['Retry release gate with stronger evidence.'],
        attempt: attempt + 1,
        terminal: false,
        remediation,
      };
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: inputData.taskPlan,
      releaseGate: gate,
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Release gate did not pass judgment within retry budget.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: remediation.length ? remediation : ['Inspect release gate evidence and rerun tester stage.'],
      attempt,
      terminal: true,
      remediation,
    };
  },
});

const finalizeReleaseGateLoopStep = createStep({
  id: 'release-gate',
  description: 'Finalize native release gate retry loop output.',
  inputSchema: releaseGateLoopStateSchema,
  outputSchema: deliveryStageOutputSchema,
  scorers: deliveryReleaseGateStepScorers,
  execute: async ({ inputData }) => ({
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    taskPlan: inputData.taskPlan,
    releaseGate: inputData.releaseGate,
    status: inputData.status,
    runId: inputData.runId,
    summary: inputData.summary,
    artifacts: inputData.artifacts,
    checks: inputData.checks,
    judgments: inputData.judgments,
    questions: inputData.questions,
    nextSteps: inputData.nextSteps,
  }),
});

const createDeploymentReportStep = createStep({
  id: 'create-deployment-report',
  description: 'Run deployer from a passing release gate and write the deployment report artifact.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deploymentReportStageSchema,
  resumeSchema: deploymentApprovalResumeSchema,
  suspendSchema: deploymentApprovalSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend }) => {
    if (inputData.status !== 'release_ready') return inputData;
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment');

    const deployer = requiredAgent(mastra, 'deployer');
    const artifacts = [...inputData.artifacts];
    const stage = 'deploy';
    const releaseGatePath = latestArtifactPath(artifacts, 'release-gate', '.delivery/artifacts/release-gate.json');

    if (inputData.deployMode === 'real' && !resumeData) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_input_required',
          stage: 'deploy:approval',
          artifact_type: 'release-gate',
          path: releaseGatePath,
        },
      });

      return await suspend(
        {
          reason: 'Real deployment requires human approval before the deployer runs.',
          deployMode: 'real' as const,
          releaseGatePath,
          releaseGateSummary: inputData.releaseGate.summary,
          blockers: inputData.releaseGate.blockers,
          nextSteps: inputData.nextSteps,
        },
        { resumeLabel: 'approve-real-deployment' },
      );
    }

    if (inputData.deployMode === 'real' && resumeData?.approved === false) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_approval',
          stage: 'deploy:approval',
          approved: false,
          approver: resumeData.approver,
          note: resumeData.notes,
        },
      });

      return {
        ...inputData,
        status: 'failed' as const,
        summary: 'Real deployment was rejected by human approval.',
        nextSteps: resumeData.notes ? [resumeData.notes] : ['Deployment rejected before any real deploy command ran.'],
      };
    }

    if (inputData.deployMode === 'real' && resumeData?.approved) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'human_approval',
          stage: 'deploy:approval',
          approved: true,
          approver: resumeData.approver,
          note: resumeData.notes,
        },
      });
    }

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role: 'deployer',
      mastra,
    });
    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'artifact_read',
        stage,
        artifact_type: 'release-gate',
        path: releaseGatePath,
      },
    });

    const deployResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.build,
      operation: (abortSignal) =>
        deployer.generate(
          `Deploy the approved build.

Release gate path: ${releaseGatePath}
Deploy mode: ${inputData.deployMode}

Rules:
- Do not deploy unless the release gate is PASS with zero blockers.
- In mock mode, start the application locally or its closest runnable form, record a deploy event, run direct probes, and record live_verify events.
- In real mode, use Wrangler CLI or an existing project script that directly wraps Wrangler. Do not use GitHub Actions as the deployment path.
- Local git and gh CLI may be used for source-control operations such as commit, push, or PR metadata, but deployment evidence must come from Wrangler and live probes.
- Verification must include at least one happy path and one error path when the app shape allows it.
- Return a deployment report with exact revision, verification results, issues, next action, and rollback steps.

Release gate:
${JSON.stringify(inputData.releaseGate, null, 2)}`,
          {
            abortSignal,
            requestContext: createDeliveryRequestContext(inputData.repoPath),
            maxSteps: deployerAgentMaxSteps,
            toolCallConcurrency: 1,
            structuredOutput: {
              schema: deployerOutputSchema,
              ...deliveryToolStructuredOutputOptions,
              instructions: 'Return only { "report": <deployment-report> } after deployment and live verification.',
            },
          },
        ),
    });

    const { report } = parseDeliveryStructuredOutput(deployerOutputSchema, deployResponse, 'deployer');
    const reportPath = '.delivery/artifacts/deployment-report.json';
    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: reportPath,
      artifact: report,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'deployment-report',
      path: reportPath,
      mastra,
    });
    artifacts.push(reportPath);

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      reason: 'complete_stage',
      mastra,
    });

    return {
      ...inputData,
      artifacts,
      deploymentReport: report,
      deploymentReportPath: reportPath,
    };
  },
});

const createDeploymentJudgmentStep = createStep({
  id: 'judge-deployment-report',
  description: 'Run deployment deterministic gates and rubric judgment, then finish the delivery run.',
  inputSchema: deploymentReportStageSchema,
  outputSchema: workflowOutputSchema,
  scorers: deliveryDeploymentStepScorers,
  execute: async ({ inputData, mastra }) => {
    const finishRun = async (status: DeliveryRunStatus) => {
      await finishDeliveryRunState({ repoPath: inputData.repoPath, status, mastra });
      await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
    };

    const baseOutput = () => ({
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
    });

    if (inputData.status === 'gate_failed') {
      await finishRun('failed');
      return {
        ...baseOutput(),
        status: 'failed' as const,
        nextSteps: inputData.nextSteps.length ? inputData.nextSteps : ['Fix release gate blockers before deployment.'],
      };
    }

    if (inputData.status === 'stuck') {
      await finishRun('stuck');
      return baseOutput();
    }

    if (inputData.status === 'failed') {
      await finishRun('failed');
      return baseOutput();
    }

    if (inputData.status !== 'release_ready') return baseOutput();
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment judgment');
    if (!inputData.deploymentReport || !inputData.deploymentReportPath) {
      throw new Error('deployment report stage did not provide a deployment report for judgment');
    }

    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];
    const stage = 'deploy';
    const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
    const deterministicResults = deploymentDeterministicResults({
      stage,
      releaseGate: inputData.releaseGate,
      events: deliveryEvents,
    });
    checks.push(...checkSummaries(deterministicResults, 'deployment'));

    const deploymentJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'deployment-report',
      subjectName: inputData.deploymentReportPath,
      subject: {
        report: inputData.deploymentReport,
        release_gate: inputData.releaseGate,
        evidence_events: deliveryEvents.filter((event) => event.stage === stage),
      },
      deterministicResults,
      slug: 'deployment-report',
    });
    artifacts.push(deploymentJudge.judgeOutputPath, deploymentJudge.judgmentPath);
    judgments.push(deploymentJudge.ref);

    const complete = inputData.deploymentReport.result === 'success' && deploymentJudge.judgment.passed;
    await finishRun(complete ? 'complete' : 'failed');

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      status: complete ? ('complete' as const) : ('failed' as const),
      runId: inputData.runId,
      summary: complete
        ? `Deployment complete: ${inputData.deploymentReport.environment} ${inputData.deploymentReport.revision}`
        : 'Deployment failed judgment or reported failure.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: complete ? [inputData.deploymentReport.next_action] : deploymentJudge.judgment.remediation,
    };
  },
});

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description:
    'Native Delivery Engine workflow: initialize run state, plan, review, build, release-gate, deploy, and finish.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(initializeRunStep)
  .then(createPlannerArtifactsStep)
  .then(createPlanGateStep)
  .then(syncPlanStateStep)
  .then(prepareReviewLoopStep)
  .dountil(executeReviewAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReviewLoopStep)
  .then(syncReviewStateStep)
  .then(prepareBuildTasksStep)
  .foreach(deliveryBuildTaskWorkflow, { concurrency: 1 })
  .then(aggregateBuildTaskResultsStep)
  .then(syncBuildStateStep)
  .then(prepareReleaseGateLoopStep)
  .dountil(executeReleaseGateAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReleaseGateLoopStep)
  .then(syncReleaseGateStateStep)
  .then(createDeploymentReportStep)
  .then(syncDeploymentReportStateStep)
  .then(createDeploymentJudgmentStep)
  .then(syncFinalDeliveryStateStep)
  .commit();
