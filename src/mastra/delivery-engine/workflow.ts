import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { deliveryRunMemory } from './memory';
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
import { deliveryStructuredOutputOptions } from './models';
import { parseDeliveryStructuredOutput } from './structured-output';

const execFileAsync = promisify(execFile);

const deliveryDeployModeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['local', 'mock', 'preview'].includes(normalized)) return 'local';
  if (['production', 'prod', 'real'].includes(normalized)) return 'production';
  return value;
}, z.enum(['local', 'production']).default('local'));

const workflowInputSchema = z.object({
  repoPath: z.string().describe('Absolute path to the target repo.'),
  visionPath: z.string().describe('Path to vision.md inside repoPath; relative paths are resolved under repoPath.'),
  specPath: z.string().describe('Path to spec.md inside repoPath; relative paths are resolved under repoPath.'),
  maxRetries: z.number().int().min(0).default(2),
  deployMode: deliveryDeployModeSchema.describe('local/production target. mock/real remain supported aliases.'),
  reviewMode: z.enum(['fast', 'thorough']).default('thorough'),
});

const taskSchema = z.object({
  id: z.string(),
  owner: z.enum(['engineer', 'designer']),
  deliverable: z.string(),
  depends_on: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  owned_surfaces: z.array(z.string()),
  source_task_id: z.string().optional(),
  source_acceptance_criteria: z.array(z.string()).optional(),
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

const acceptanceContractSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  status: z.enum(['verified', 'unverified']),
  evidence: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});

const implementationNoteSchema = z.object({
  artifact_type: z.literal('implementation-note'),
  task: z.string(),
  changes: z.array(z.string()).min(1),
  files_touched: z.array(z.string()).default([]),
  acceptance_contracts: z.array(acceptanceContractSchema).optional(),
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
  next_action: z.enum(['monitor', 'rollback', 'proceed', 'fix']),
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

const plannerPolicyVersion = 'worker-first-local-v15';

const sourcePolicySchema = z.object({
  pagesRequired: z.boolean().default(false),
  requiredProfileKinds: z.array(z.string()).default([]),
  talkingHeadTranscriptRequired: z.boolean().default(false),
  bookmarksServiceRequired: z.boolean().default(false),
});

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
  sourcePolicy,
}: {
  repoPath: string;
  sourceFingerprint: string;
  sourcePolicy: SourcePolicy;
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
  if (!pagesFunctionsExceptionHygiene(taskPlan.data, sourcePolicy).passed) return undefined;
  if (!projectScaffoldHygiene(repoPath, taskPlan.data).passed) return undefined;
  if (!configSchemaTaskSplitHygiene(taskPlan.data).passed) return undefined;
  if (!operatorDocumentationHygiene(taskPlan.data).passed) return undefined;
  if (!generatedSliceDependencyHygiene(taskPlan.data).passed) return undefined;

  return { readout: readout.data, taskPlan: taskPlan.data, cacheValidated: cache.success };
}

const testerOutputSchema = z.object({
  gate: releaseGateSchema,
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
  sourcePolicy: sourcePolicySchema,
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
  deployMode: z.enum(['local', 'production']).optional(),
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
  deployMode: z.enum(['local', 'production']).optional(),
  reviewMode: z.enum(['fast', 'thorough']).optional(),
  artifacts: z.array(z.string()).default([]),
  checks: z.array(checkSummarySchema).default([]),
  judgments: z.array(judgmentRefSchema).default([]),
  questions: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
  sourcePolicy: sourcePolicySchema.optional(),
  taskPlan: taskPlanSchema.optional(),
  releaseGate: releaseGateSchema.optional(),
  deploymentReport: deploymentReportSchema.optional(),
  deploymentReportPath: z.string().optional(),
});

const deliveryStageOutputSchema = workflowOutputSchema.extend({
  repoPath: z.string(),
  maxRetries: z.number().int().min(0),
  deployMode: z.enum(['local', 'production']),
  reviewMode: z.enum(['fast', 'thorough']).default('thorough'),
  sourcePolicy: sourcePolicySchema.optional(),
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
  deployMode: z.literal('production'),
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
type SourcePolicy = z.infer<typeof sourcePolicySchema>;
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
  sourcePolicy: state?.sourcePolicy,
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
    sourcePolicy: output.sourcePolicy ?? current.sourcePolicy,
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

function looksLikeSettledDeliveryPolicy(decision: string) {
  return (
    /\b(?:Pages Functions?|Cloudflare Pages)\b[\s\S]{0,80}\bWorkers?\b/i.test(decision) ||
    /\bWorkers?\b[\s\S]{0,80}\b(?:Pages Functions?|Cloudflare Pages)\b/i.test(decision) ||
    /\b(?:React|Next\.?js|Vue|Svelte|JSX|TSX|Vite|frontend framework)\b/i.test(decision) ||
    /\bGitHub Actions?\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bdeploy\b[\s\S]{0,80}\bGitHub Actions?\b/i.test(decision) ||
    /\bWrangler\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bWorkers AI\b[\s\S]{0,80}\bbinding\b/i.test(decision) ||
    /\blocal validation\b|\bproduction approval\b/i.test(decision)
  );
}

function namesTaskScopedBlocker(decision: string) {
  return /\bblocks?\s+T\d[\w-]*\b/i.test(decision) || /\bbefore\s+T\d[\w-]*\b/i.test(decision);
}

function looksLikeSafeBookmarksAdapterAmbiguity(question: string) {
  return (
    /\bBOOKMARKS\b|\bbookmarks service\b|\benv\.BOOKMARKS\b/i.test(question) &&
    /\b(endpoint|RPC|method|path|parameters?|response envelope|contract|date-window|date window|API shape)\b/i.test(question)
  );
}

export function normalizeReadoutSafeAdapterAmbiguities(readout: z.infer<typeof readoutSchema>) {
  const safeAdapterQuestions = readout.blocking_ambiguities.filter(looksLikeSafeBookmarksAdapterAmbiguity);
  if (!safeAdapterQuestions.length) return readout;

  const blocking_ambiguities = readout.blocking_ambiguities.filter(
    (question) => !looksLikeSafeBookmarksAdapterAmbiguity(question),
  );
  const safeAssumptions = safeAdapterQuestions.map(
    (question) =>
      `Safe adapter default: ${question} Proceed with env.BOOKMARKS.fetch behind src/bookmarkClient.ts using a date-window request and normalized Bookmark[] response; document the adapter contract risk instead of blocking delivery.`,
  );

  return {
    ...readout,
    blocking_ambiguities,
    safe_assumptions: Array.from(new Set([...readout.safe_assumptions, ...safeAssumptions])),
  };
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

    if (looksLikeSettledDeliveryPolicy(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] asks about settled delivery policy; move it to readout.safe_assumptions or taskPlan.risks and proceed with the Worker-first defaults.`,
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

function sourceLineNegatesPages(line: string) {
  return (
    /\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b.{0,80}\b(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)\b/i.test(
      line,
    ) ||
    /\b(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)\b.{0,80}\b(?:not|unsupported|forbidden|banned)\b/i.test(
      line,
    )
  );
}

function sourceLineDeclaresPages(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes('?') || sourceLineNegatesPages(trimmed)) return false;

  const pagesProduct = String.raw`(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)`;
  return [
    new RegExp(String.raw`\b(?:use|using|target|platform|deploy(?:ment)?|host(?:ing)?|build|create|implement|must|require[sd]?)\b.{0,100}\b${pagesProduct}\b`, 'i'),
    new RegExp(String.raw`\b${pagesProduct}\b.{0,100}\b(?:use|using|target|platform|deploy(?:ment)?|host(?:ing)?|must|require[sd]?)\b`, 'i'),
    new RegExp(String.raw`\b(?:deployment|target platform|platform)\s*:\s*${pagesProduct}\b`, 'i'),
  ].some((pattern) => pattern.test(trimmed));
}

export function sourceDocumentsDeclarePages(sourceDocuments: Array<{ path: string; content: string }>) {
  return sourceDocuments.some((document) => document.content.split(/\r?\n/).some(sourceLineDeclaresPages));
}

function sourceDocumentText(sourceDocuments: Array<{ path: string; content: string }>) {
  return sourceDocuments.map((document) => document.content).join('\n\n');
}

export function sourceDocumentsRequiredProfileKinds(sourceDocuments: Array<{ path: string; content: string }>) {
  const text = sourceDocumentText(sourceDocuments);
  const requiredKinds = new Set<string>();
  if (/\baudience_segments\b/i.test(text) || /\baudience\s+segments\s+profile\b/i.test(text)) {
    requiredKinds.add('audience_segments');
  }
  if (/\bvoice_profile\b/i.test(text) || /\bvoice\s+profile\b/i.test(text)) {
    requiredKinds.add('voice_profile');
  }
  return [...requiredKinds];
}

export function sourceDocumentsDeclareTalkingHeadTranscriptContract(sourceDocuments: Array<{ path: string; content: string }>) {
  const text = sourceDocumentText(sourceDocuments);
  return (
    /\btalking[-\s]?head\b/i.test(text) &&
    /\bTranscriptResult\b|\btranscript\s+result\b|\bready-to-record\b/i.test(text) &&
    /\bGET\s+\/latest\b|\/latest\b/i.test(text) &&
    (/\baudience_segments\b|\baudience\s+segments\s+profile\b/i.test(text) || /\bvoice_profile\b|\bvoice\s+profile\b/i.test(text))
  );
}

export function sourceDocumentsDeclareBookmarksService(sourceDocuments: Array<{ path: string; content: string }>) {
  const text = sourceDocumentText(sourceDocuments);
  return /\bBOOKMARKS\b|\benv\.BOOKMARKS\b|\bbookmarks\s+service\b|\bbookmark\s+service\b/i.test(text);
}

function sourceLineNegatesShortLinks(line: string) {
  return (
    /\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b.{0,100}(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?|\/api\/links|\/l\/)/i.test(
      line,
    ) ||
    /(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?|\/api\/links|\/l\/).{0,100}\b(?:not|unsupported|forbidden|banned)\b/i.test(
      line,
    )
  );
}

export function sourceDocumentsDeclareShortLinkLifecycle(sourceDocuments: Array<{ path: string; content: string }>) {
  const positiveText = sourceDocuments
    .flatMap((document) => document.content.split(/\r?\n/))
    .filter((line) => !sourceLineNegatesShortLinks(line))
    .join('\n');
  return /\b(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?)\b/i.test(positiveText);
}

function sourcePolicyFromDocuments(sourceDocuments: Array<{ path: string; content: string }>): SourcePolicy {
  return {
    pagesRequired: sourceDocumentsDeclarePages(sourceDocuments),
    requiredProfileKinds: sourceDocumentsRequiredProfileKinds(sourceDocuments),
    talkingHeadTranscriptRequired: sourceDocumentsDeclareTalkingHeadTranscriptContract(sourceDocuments),
    bookmarksServiceRequired: sourceDocumentsDeclareBookmarksService(sourceDocuments),
  };
}

function bookmarksAdapterPolicyLine(sourcePolicy: SourcePolicy) {
  return sourcePolicy.bookmarksServiceRequired
    ? '\n- The BOOKMARKS service API shape is not a human blocker. Default to an env.BOOKMARKS.fetch adapter in src/bookmarkClient.ts with a date-window request and normalized Bookmark[] response, then record contract mismatch as a risk.'
    : '';
}

function sourceDocumentsFromRepo(repoPath: string) {
  const root = resolve(repoPath);
  return ['vision.md', 'spec.md'].flatMap((path) => {
    const fullPath = join(root, path);
    return existsSync(fullPath) ? [{ path, content: readFileSync(fullPath, 'utf8') }] : [];
  });
}

function sourcePolicyFromRepo(repoPath: string): SourcePolicy {
  return sourcePolicyFromDocuments(sourceDocumentsFromRepo(repoPath));
}

function taskPlanPagesFunctionSurfaces(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    effectiveOwnedSurfaces(task)
      .map(normalizeDeliveryPathReference)
      .filter((surface) => surface === 'functions' || surface.startsWith('functions/'))
      .map((surface) => `${task.id}:${surface}`),
  );
}

export function pagesFunctionsExceptionHygiene(taskPlan: TaskPlan, sourcePolicy?: SourcePolicy) {
  const pagesSurfaces = taskPlanPagesFunctionSurfaces(taskPlan);
  if (!pagesSurfaces.length) return { passed: true, reason: 'ok' };
  if (sourcePolicy?.pagesRequired) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `Task plan owns Pages Functions surfaces (${pagesSurfaces.join(', ')}), but vision/spec did not declaratively require Cloudflare Pages. Use standalone Worker routes under src/ or workers/ unless the source docs explicitly say to use Pages.`,
  };
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
        reason: `${task.id} owned_surfaces contains conceptual surface "${surface}". Use concrete repo paths like wrangler.jsonc, src/index.ts, public/settings.html, migrations/0001_schema.sql, or "unknown: <reason>".`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

function normalizedOwnedSurfaces(task: Task) {
  return task.owned_surfaces.map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

function taskSourceTaskId(task: Task) {
  return task.source_task_id?.trim() || task.id;
}

function taskAcceptanceContractCriteria(task: Task) {
  return Array.from(new Set([...(task.source_acceptance_criteria ?? []), ...task.acceptance_criteria].filter(Boolean)));
}

function acceptanceContractId(task: Task, index: number) {
  return `${taskSourceTaskId(task)}-AC${String(index + 1).padStart(2, '0')}`;
}

function acceptanceContractReferences(criterion: string) {
  return Array.from(
    new Set(
      criterion.match(
        /(?:^|\s)((?:src|public|migrations|workers|assets)\/[A-Za-z0-9_./-]+|wrangler\.(?:jsonc?|toml)|package\.json|tsconfig\.json|README\.md|\.gitignore|\.env\*?|\.dev\.vars\*?)/g,
      ) ?? [],
    ),
  ).map((match) => match.trim());
}

function ownsExactSurface(task: Task, path: string) {
  return normalizedOwnedSurfaces(task).includes(path);
}

function taskOwnsAnyExactSurface(task: Task, paths: readonly string[]) {
  return paths.some((path) => ownsExactSurface(task, path));
}

function ownsPackageScaffold(task: Task) {
  return ownsExactSurface(task, 'package.json');
}

function ownsWorkerConfigSurface(task: Task) {
  return taskOwnsAnyExactSurface(task, workerConfigSurfacePaths);
}

function normalizeScaffoldRootTask(repoPath: string, task: Task, includeWorkerConfig: boolean) {
  const ownedSurfaces = [...task.owned_surfaces];
  const acceptanceCriteria = [...task.acceptance_criteria];

  if (!ownsExactSurface(task, '.gitignore')) {
    ownedSurfaces.push('.gitignore');
    acceptanceCriteria.push(
      '.gitignore excludes node_modules/, .wrangler/, .delivery/, .dev.vars*, .env*, and *.cpuprofile so local delivery artifacts, Wrangler state, startup profiles, dependencies, and local secrets stay out of git.',
    );
  }

  if (includeWorkerConfig && !releaseGateWorkerConfigPath(repoPath) && !ownsWorkerConfigSurface(task)) {
    ownedSurfaces.push('wrangler.jsonc');
    acceptanceCriteria.push(
      'wrangler.jsonc exists in the root scaffold with the Worker entrypoint, env.staging/env.production, nodejs_compat, observability, and any required bindings so Wrangler validation can run from the first build slice.',
    );
  }

  if (ownsJavaScriptInputSurface(task) && !ownsTypeScriptInputSurface(task)) {
    if (!ownsExactSurface(task, 'scripts/check-js.js')) {
      ownedSurfaces.push('scripts/check-js.js');
    }
    acceptanceCriteria.push(
      'package.json includes scripts.typecheck exactly "node scripts/check-js.js" and scripts/check-js.js validates current repo JavaScript files with node --check without adding TypeScript or a no-op gate.',
    );
  }

  return {
    ...task,
    owned_surfaces: Array.from(new Set(ownedSurfaces)),
    acceptance_criteria: Array.from(new Set(acceptanceCriteria)),
  };
}

function workerSourceSurfaceIsTypeScript(surface: string) {
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

function workerSourceSurfaceIsConcrete(surface: string) {
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
      (surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsJavaScript(surface),
  );
}

function ownsTypeScriptInputSurface(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      (surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsTypeScript(surface),
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

const profileContractProducerSurfaces = [
  'src/validation.ts',
  'src/contracts.ts',
  'src/domain.ts',
  'src/domain/profileKinds.ts',
  'src/domain/profile.ts',
  'src/domain/profiles.ts',
  'src/domain/profileArtifacts.ts',
];
const profileContractConsumerSurfaces = ['migrations/0001_schema.sql', 'src/storage/profiles.ts', 'src/routes/profiles.ts'];

function profileContractProducerTask(taskPlan: TaskPlan) {
  return taskPlan.tasks.find((task) => taskOwnsAnyExactSurface(task, profileContractProducerSurfaces));
}

function profileContractConsumerTasks(taskPlan: TaskPlan) {
  return taskPlan.tasks.filter(
    (task) => taskOwnsAnyExactSurface(task, profileContractConsumerSurfaces) || taskOwnsD1MigrationFile(task),
  );
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
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
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
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
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

const workerConfigSurfacePaths = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function taskOwnsWorkerConfigFile(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => workerConfigSurfacePaths.includes(path));
}

function taskOwnsD1MigrationFile(task: Task) {
  return taskOwnedBoundaryPaths(task).some((path) => path.startsWith('migrations/') && path.endsWith('.sql'));
}

function criterionMentionsAny(criterion: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(criterion));
}

const workerConfigCriterionPatterns = [
  /\bwrangler(?:\.(?:jsonc|json|toml))?\b/i,
  /\bcompatibility_(?:date|flags?)\b/i,
  /\bnodejs_compat\b/i,
  /\bobservability\b/i,
  /\b(?:binding|bindings|vars|secrets?)\b/i,
  /\bWorkers AI\b/i,
];

const d1SchemaCriterionPatterns = [
  /\bmigrations?\b/i,
  /\bD1\b/i,
  /\bSQL\b/i,
  /\bschema\b/i,
  /\btables?\b/i,
  /\bindexes?\b/i,
];

function splitConfigSchemaAcceptanceCriteria(task: Task, kind: 'config' | 'schema') {
  const defaults =
    kind === 'config'
      ? [
          'Configure Wrangler separately from D1 schema migrations so bindings, compatibility, and observability can be validated without touching SQL.',
          'Keep Worker config aligned with current Worker policy: wrangler.jsonc for new projects, current compatibility_date, nodejs_compat, observability, and required bindings.',
        ]
      : [
          'Define D1 schema migrations separately from Worker config so SQL can be reviewed, applied, and repaired on its own.',
          'Keep migrations compatible with the Worker code and explicit D1 binding planned in Wrangler config.',
        ];
  const patterns = kind === 'config' ? workerConfigCriterionPatterns : d1SchemaCriterionPatterns;
  const matching = task.acceptance_criteria.filter((criterion) => criterionMentionsAny(criterion, patterns));
  return Array.from(new Set([...defaults, ...matching]));
}

function splitWorkerConfigAndD1SchemaTask(task: Task) {
  if (!taskOwnsWorkerConfigFile(task) || !taskOwnsD1MigrationFile(task)) return [task];

  const configSurfaces: string[] = [];
  const schemaSurfaces: string[] = [];
  const otherSurfaces: string[] = [];

  for (const surface of task.owned_surfaces) {
    const path = concreteOwnedSurfacePath(surface);
    if (path && workerConfigSurfacePaths.includes(path)) {
      configSurfaces.push(surface);
    } else if (path && path.startsWith('migrations/') && path.endsWith('.sql')) {
      schemaSurfaces.push(surface);
    } else {
      otherSurfaces.push(surface);
    }
  }

  const schemaTaskId = `${task.id}-d1-schema`;
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
  return [
    {
      ...task,
      deliverable: `${task.deliverable} (Worker configuration slice)`,
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'config'),
      owned_surfaces: [...configSurfaces, ...otherSurfaces],
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
    {
      ...task,
      id: schemaTaskId,
      deliverable: `${task.deliverable} (D1 schema slice)`,
      depends_on: [task.id],
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'schema'),
      owned_surfaces: schemaSurfaces,
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
  ];
}

export function normalizeTaskPlanConfigSchemaTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitWorkerConfigAndD1SchemaTask(task);
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

export function configSchemaTaskSplitHygiene(taskPlan: TaskPlan) {
  const combinedTask = taskPlan.tasks.find((task) => taskOwnsWorkerConfigFile(task) && taskOwnsD1MigrationFile(task));
  if (!combinedTask) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `${combinedTask.id} owns both Wrangler config and D1 migration files. Split Worker config and migrations into separate engineer tasks so config hygiene, SQL review, and Wrangler validation can repair independently.`,
  };
}

function taskOwnsPathMatching(task: Task, pattern: RegExp) {
  return taskOwnedBoundaryPaths(task).some((path) => pattern.test(path));
}

function taskOwnsRouterSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/);
}

function taskOwnsRouteModule(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes(?:\/|[A-Z]).*|[A-Za-z0-9_-]*Routes)\.[cm]?[jt]s$/i);
}

function taskOwnsSessionRoute(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes\/session|sessionRoutes)\.[cm]?[jt]s$/i);
}

function taskOwnsProfileRoute(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes\/.*profiles?|routesProfiles|profileRoutes)\.[cm]?[jt]s$/i);
}

function taskOwnsProfileRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/profiles|profileRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsRunRoute(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:routes\/.*(?:runs?|latest|regeneration|candidate)|(?:run|latest|regeneration|candidate)Routes)\.[cm]?[jt]s$/i);
}

function taskOwnsRunRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/runs|runRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsTranscriptRepositorySurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:storage\/transcripts|transcriptRepository)\.[cm]?[jt]s$/i);
}

function taskOwnsWorkflowSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:workflows\/weeklyWorkflow|weeklyWorkflow)\.[cm]?[jt]s$/i);
}

function taskOwnsContractSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:contracts|validation)\.[cm]?[jt]s$/i);
}

function taskOwnsAiValidationSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:aiJson|validation|contracts)\.[cm]?[jt]s$/i);
}

function taskOwnsAiPipelineSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/(?:candidatePipeline|scoring|transcriptGenerator|prompts|aiClient)\.[cm]?[jt]s$/i);
}

function taskOwnsAuthSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/auth\.[cm]?[jt]s$/);
}

function taskOwnsPublicAppSurface(task: Task) {
  return taskOwnsPathMatching(task, /^public\/(?:index\.html|app\.js)$/);
}

function taskOwnsIndexSurface(task: Task) {
  return taskOwnsPathMatching(task, /^src\/index\.[cm]?[jt]s$/);
}

function taskOwnsReadme(task: Task) {
  return taskOwnedBoundaryPaths(task).includes('README.md');
}

function appendTaskAcceptanceCriteria(task: Task, criteria: string[]) {
  const acceptance_criteria = Array.from(new Set([...task.acceptance_criteria, ...criteria]));
  return acceptance_criteria.length === task.acceptance_criteria.length ? task : { ...task, acceptance_criteria };
}

function publicUiRawAdminTokenCriterion(criterion: string) {
  return (
    /\bpublic\/app\.js\b/i.test(criterion) &&
    /\bADMIN_TOKEN\b/.test(criterion) &&
    /\b(collects?|sends?|Authorization:\s*Bearer|raw)\b/i.test(criterion) &&
    !/\b(browser-safe|session|cookie|HttpOnly)\b/i.test(criterion)
  );
}

function withoutPublicUiRawAdminTokenCriteria(task: Task) {
  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !publicUiRawAdminTokenCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !publicUiRawAdminTokenCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function rootScaffoldWorkflowExecutionCriterion(criterion: string) {
  return /\bWorkflow execution receives or resumes a queued run\b/i.test(criterion);
}

function taskIsRootScaffold(task: Task) {
  return task.depends_on.length === 0 && ownsPackageScaffold(task) && taskOwnsIndexSurface(task);
}

function withoutRootScaffoldWorkflowExecutionCriteria(task: Task) {
  if (!taskIsRootScaffold(task)) return task;

  const acceptance_criteria = task.acceptance_criteria.filter((criterion) => !rootScaffoldWorkflowExecutionCriterion(criterion));
  const source_acceptance_criteria = task.source_acceptance_criteria?.filter(
    (criterion) => !rootScaffoldWorkflowExecutionCriterion(criterion),
  );

  if (
    acceptance_criteria.length === task.acceptance_criteria.length &&
    (source_acceptance_criteria?.length ?? 0) === (task.source_acceptance_criteria?.length ?? 0)
  ) {
    return task;
  }

  return {
    ...task,
    acceptance_criteria,
    ...(task.source_acceptance_criteria ? { source_acceptance_criteria } : {}),
  };
}

function taskHasRouteIntegrationContract(task: Task) {
  return (
    taskOwnsRouterSurface(task) &&
    task.acceptance_criteria.some((criterion) =>
      /reachable through (?:the )?(?:src\/)?router|all declared (?:api )?endpoints?|routes? reachable through the Worker fetch path/i.test(
        criterion,
      ),
    )
  );
}

function dedupeRouteIntegrationTasks(tasks: Task[]) {
  const integrationTasks = tasks.filter(taskHasRouteIntegrationContract);
  if (integrationTasks.length <= 1) return { tasks, changed: false };

  const [primary, ...duplicates] = integrationTasks;
  const integrationIds = new Set(integrationTasks.map((task) => task.id));
  const duplicateIds = new Set(duplicates.map((task) => task.id));
  const primaryTask = {
    ...primary,
    depends_on: Array.from(
      new Set(integrationTasks.flatMap((task) => task.depends_on).filter((dependency) => !integrationIds.has(dependency))),
    ),
    acceptance_criteria: Array.from(new Set(integrationTasks.flatMap((task) => task.acceptance_criteria))),
    owned_surfaces: Array.from(new Set(integrationTasks.flatMap((task) => task.owned_surfaces))),
  };

  return {
    tasks: tasks
      .filter((task) => !duplicateIds.has(task.id))
      .map((task) => {
        if (task.id === primary.id) return primaryTask;
        const depends_on = Array.from(
          new Set(task.depends_on.map((dependency) => (duplicateIds.has(dependency) ? primary.id : dependency))),
        );
        return depends_on.length === task.depends_on.length &&
          depends_on.every((dependency, index) => dependency === task.depends_on[index])
          ? task
          : { ...task, depends_on };
      }),
    changed: true,
  };
}

function routeModuleStyle(tasks: Task[]) {
  return tasks.some((task) => taskOwnedBoundaryPaths(task).some((path) => path.startsWith('src/routes/'))) ? 'nested' : 'flat';
}

function routerBoundaryProviderTasks(tasks: Task[]) {
  return tasks.filter((task) => taskOwnsRouterSurface(task) && !taskHasRouteIntegrationContract(task));
}

function withAuthSessionTask(taskPlan: TaskPlan, tasks: Task[]) {
  const hasPublicApp = tasks.some(taskOwnsPublicAppSurface);
  const authTasks = tasks.filter(taskOwnsAuthSurface);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  if (!hasPublicApp || !authTasks.length || tasks.some(taskOwnsSessionRoute)) return { tasks, changed: false };

  const surface = routeModuleStyle(tasks) === 'nested' ? 'src/routes/session.js' : 'src/sessionRoutes.js';
  return {
    tasks: [
      ...tasks,
      {
        id: uniqueTaskId({ ...taskPlan, tasks }, 'E20-auth-session'),
        owner: 'engineer' as const,
        deliverable: 'Implement the browser-safe auth/session route boundary before protected feature routes and UI work.',
        depends_on: Array.from(new Set([...authTasks, ...routerTasks].map((task) => task.id))),
        acceptance_criteria: [
          `${surface} implements a dedicated browser session endpoint for the public UI before profile/run UI work begins.`,
          `${surface} exchanges a valid operator credential for a short-lived HttpOnly SameSite cookie without persisting ADMIN_TOKEN in public assets, localStorage, sessionStorage, or query strings.`,
          `${surface} defines session validation and logout/status behavior, fails closed when ADMIN_TOKEN is missing, and returns structured 401/403 responses for invalid credentials.`,
          'Protected profile, run, latest, and regeneration routes validate either direct API/operator Authorization: Bearer <ADMIN_TOKEN> access or the browser-safe session cookie through src/auth.js.',
        ],
        owned_surfaces: [surface],
      },
    ],
    changed: true,
  };
}

function withRouteIntegrationTask(taskPlan: TaskPlan, tasks: Task[]) {
  const deduped = dedupeRouteIntegrationTasks(tasks);
  tasks = deduped.tasks;

  const routeTasks = tasks.filter(taskOwnsRouteModule);
  const routerTasks = routerBoundaryProviderTasks(tasks);
  if (!routeTasks.length || !routerTasks.length) return { tasks, changed: deduped.changed };

  const alreadyHasIntegration = tasks.some(taskHasRouteIntegrationContract);
  if (alreadyHasIntegration) {
    let changed = deduped.changed;
    const expectedDependencies = Array.from(new Set([...routerTasks, ...routeTasks].map((task) => task.id)));
    tasks = tasks.map((task) => {
      if (!taskHasRouteIntegrationContract(task)) return task;
      const depends_on = expectedDependencies.filter((dependency) => dependency !== task.id);
      if (depends_on.length === task.depends_on.length && depends_on.every((dependency, index) => dependency === task.depends_on[index])) {
        return task;
      }
      changed = true;
      return { ...task, depends_on };
    });
    return { tasks, changed };
  }

  const routerSurface = taskOwnedBoundaryPaths(routerTasks[routerTasks.length - 1]).find((path) =>
    /^src\/(?:(?:http\/)?router|http)\.[cm]?[jt]s$/.test(path),
  ) ?? 'src/router.js';
  const depends_on = Array.from(new Set([...routerTasks, ...routeTasks].map((task) => task.id)));

  return {
    tasks: [
      ...tasks,
      {
        id: uniqueTaskId({ ...taskPlan, tasks }, 'E98-route-integration'),
        owner: 'engineer' as const,
        deliverable: 'Wire generated API route modules through the Worker router after all route modules exist.',
        depends_on,
        acceptance_criteria: [
          `${routerSurface} is the single API route registration boundary after feature route modules exist.`,
          `${routerSurface} makes profile, run, latest, regenerate, health, and static asset fallback routes reachable through the Worker fetch path without importing route modules directly into src/index.js.`,
          'Every declared API endpoint is reachable through the router after this task completes.',
        ],
        owned_surfaces: [routerSurface],
      },
    ],
    changed: true,
  };
}

function taskDependsOnAny(task: Task, ids: Set<string>) {
  return task.depends_on.some((dependency) => ids.has(dependency));
}

function appendDependencies(task: Task, dependencies: string[]) {
  const depends_on = Array.from(new Set([...task.depends_on, ...dependencies.filter((dependency) => dependency !== task.id)]));
  return depends_on.length === task.depends_on.length &&
    depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ? task
    : { ...task, depends_on };
}

function withCloudflareWorkerDependencyContracts(tasks: Task[]) {
  const routerTaskIds = new Set(routerBoundaryProviderTasks(tasks).map((task) => task.id));
  const sessionTaskIds = new Set(tasks.filter(taskOwnsSessionRoute).map((task) => task.id));
  const integrationTask = tasks.find(taskHasRouteIntegrationContract);
  let changed = false;

  const next = tasks.map((task) => {
    const dependencies: string[] = [];

    if (taskOwnsRouteModule(task) && !taskOwnsSessionRoute(task)) {
      dependencies.push(...routerTaskIds, ...sessionTaskIds);
    }

    if (taskOwnsPublicAppSurface(task)) {
      dependencies.push(...sessionTaskIds);
      if (integrationTask) dependencies.push(integrationTask.id);
    }

    if (!taskIsRootScaffold(task) && taskOwnsIndexSurface(task) && integrationTask && task.id !== integrationTask.id) {
      dependencies.push(integrationTask.id);
    }

    const filtered = dependencies.filter((dependency) => dependency !== task.id);
    if (!filtered.length || taskDependsOnAny(task, new Set(filtered))) {
      const appended = appendDependencies(task, filtered);
      if (appended !== task) changed = true;
      return appended;
    }

    const appended = appendDependencies(task, filtered);
    if (appended !== task) changed = true;
    return appended;
  });

  return { tasks: next, changed };
}

export function normalizeTaskPlanCloudflareWorkerContracts(taskPlan: TaskPlan): TaskPlan {
  let changed = false;
  const indexOwnerCount = taskPlan.tasks.filter(taskOwnsIndexSurface).length;
  const hasAuthSurface = taskPlan.tasks.some(taskOwnsAuthSurface);
  const hasProfileState = taskPlan.tasks.some((task) => taskOwnsProfileRoute(task) || taskOwnsProfileRepositorySurface(task));

  let tasks = taskPlan.tasks.map((task) => {
    const rootSanitized = withoutRootScaffoldWorkflowExecutionCriteria(task);
    if (rootSanitized !== task) {
      changed = true;
      task = rootSanitized;
    }

    if (taskOwnsPublicAppSurface(task)) {
      const sanitized = withoutPublicUiRawAdminTokenCriteria(task);
      if (sanitized !== task) {
        changed = true;
        task = sanitized;
      }
    }

    const criteria: string[] = [];

    if (taskOwnsAuthSurface(task)) {
      criteria.push(
        'src/auth.js defines the protected operator credential contract as Authorization: Bearer <ADMIN_TOKEN> for API/operator calls, rejects missing or invalid credentials with structured 401/403 responses, fails closed when ADMIN_TOKEN is missing, and never reads committed or static secrets.',
        'src/auth.js provides a browser-safe auth/session boundary for the public UI: a dedicated session endpoint may exchange the operator credential for a short-lived HttpOnly SameSite cookie, and protected browser mutations must validate that session instead of requiring public/app.js to handle the raw ADMIN_TOKEN repeatedly.',
      );
    }

    if (hasAuthSurface && taskOwnsPublicAppSurface(task)) {
      criteria.push(
        'public/app.js uses the browser-safe auth/session flow for protected profile, run, activation, and regeneration calls; sends protected mutation requests with credentials included; handles unauthenticated responses; and never hardcodes, persists, or sends the raw ADMIN_TOKEN directly to feature mutation endpoints.',
      );
    }

    if (taskOwnsD1MigrationFile(task) && hasProfileState) {
      criteria.push(
        'migrations/0001_schema.sql enforces at most one active profile_artifacts row per kind with a D1/SQLite partial unique index where is_active = 1 and constrains valid profile kinds.',
      );
    }

    if (taskOwnsProfileRepositorySurface(task)) {
      criteria.push(
        'Profile storage activation runs in a D1 transaction that deactivates the previous active profile for the same kind and activates the selected profile atomically.',
      );
    }

    if (taskOwnsProfileRoute(task)) {
      criteria.push(
        'Profile upload and activation routes use the profile repository transaction for active-profile state changes instead of duplicating active-state authority in route code.',
        'Profile upload, profile activation, and profile listing routes use the auth/session boundary; for this single-user private MVP, GET /profiles must not expose private profile metadata without authentication.',
      );
    }

    if (taskOwnsContractSurface(task)) {
      criteria.push(
        'Run lifecycle contract defines the allowed state transitions queued -> running -> completed|failed, with route/scheduled code responsible for creating queued runs and workflow code responsible for running and terminal transitions.',
      );
    }

    if (taskOwnsRunRepositorySurface(task)) {
      criteria.push(
        'Run repository exposes idempotent transition helpers that enforce the run lifecycle contract and record exact profile artifact IDs used by a run before processing begins.',
      );
    }

    if (taskOwnsWorkflowSurface(task) && !taskIsRootScaffold(task)) {
      criteria.push(
        'Workflow execution receives or resumes a queued run, transitions it to running and then completed or failed, and does not create duplicate run records for the same workflow invocation.',
      );
    }

    if (taskOwnsRunRoute(task)) {
      criteria.push(
        'Run, latest, candidate, and regeneration routes delegate queued run creation, lifecycle transitions, transcript versioning, and candidate selection to service/repository boundaries instead of mutating D1 state directly in route handlers.',
      );
    }

    if (taskOwnsTranscriptRepositorySurface(task) || taskOwnsRunRoute(task)) {
      criteria.push(
        'Transcript regeneration inserts a new transcript row, preserves prior transcript rows, updates the run current transcript pointer only when intended, and keeps GET /latest deterministic for the latest completed run.',
      );
    }

    if (taskOwnsAiValidationSurface(task) || taskOwnsAiPipelineSurface(task)) {
      criteria.push(
        'AI output validation treats model JSON as untrusted input: scores are bounded integers, required rationales and transcript fields are non-empty, sourceUrls are preserved from selected sources, primarySegment is supplied, and word counts are computed by code before persistence.',
      );
    }

    if (taskOwnsRouterSurface(task)) {
      criteria.push(
        'The router surface remains the single API route registration boundary; feature routes must be registered through the router rather than dispatched directly from src/index.js.',
      );
    }

    if (indexOwnerCount > 1 && taskOwnsIndexSurface(task)) {
      criteria.push(
        'src/index.js changes preserve the existing default fetch handler, scheduled handler wiring, static asset fallback path, and WeeklyWorkflow export introduced by earlier tasks.',
        'src/index.js preserves a stable WeeklyWorkflow export whose class name matches wrangler.jsonc workflows.class_name; later workflow code may delegate to src/weeklyWorkflow.js without changing the configured export.',
      );
    }

    if (taskOwnsReadme(task)) {
      criteria.push(
        'README.md documents direct Authorization: Bearer <ADMIN_TOKEN> API/operator access, the browser-safe session/cookie flow for the public UI, and states that ADMIN_TOKEN is a Cloudflare secret that must not be committed or embedded in public assets.',
      );
    }

    if (!criteria.length) return task;
    const next = appendTaskAcceptanceCriteria(task, criteria);
    if (next !== task) changed = true;
    return next;
  });

  const withSession = withAuthSessionTask(taskPlan, tasks);
  if (withSession.changed) {
    changed = true;
    tasks = withSession.tasks;
  }

  const withIntegration = withRouteIntegrationTask(taskPlan, tasks);
  if (withIntegration.changed) {
    changed = true;
    tasks = withIntegration.tasks;
  }

  const withDependencies = withCloudflareWorkerDependencyContracts(tasks);
  if (withDependencies.changed) {
    changed = true;
    tasks = withDependencies.tasks;
  }

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

function taskPlanHasOperatorDocumentation(taskPlan: TaskPlan) {
  return taskPlan.tasks.some((task) => taskOwnedBoundaryPaths(task).includes('README.md'));
}

function uniqueTaskId(taskPlan: TaskPlan, baseId: string) {
  const existingIds = new Set(taskPlan.tasks.map((task) => task.id));
  if (!existingIds.has(baseId)) return baseId;

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export function normalizeTaskPlanOperatorDocumentation(taskPlan: TaskPlan): TaskPlan {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return taskPlan;

  const id = uniqueTaskId(taskPlan, 'E99-operator-documentation');
  return {
    ...taskPlan,
    tasks: [
      ...taskPlan.tasks,
      {
        id,
        owner: 'engineer',
        deliverable: "Document local Worker validation, required Cloudflare resources, and Chris's human-approved Wrangler deployment flow.",
        depends_on: taskPlan.tasks.map((task) => task.id),
        acceptance_criteria: [
          'README.md documents local development and validation with Wrangler CLI, including npm scripts and expected ports.',
          'README.md lists required Cloudflare resources, bindings, secrets, and Workers AI binding expectations.',
          'README.md explains source-control expectations: local git checkpoints are allowed, while pushes/PRs through gh require explicit human direction, and production deploy waits for human approval before running wrangler deploy --env production.',
        ],
        owned_surfaces: ['README.md'],
      },
    ],
  };
}

export function operatorDocumentationHygiene(taskPlan: TaskPlan) {
  if (taskPlanHasOperatorDocumentation(taskPlan)) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason:
      'Task plan does not include README.md operator documentation. Add an engineer-owned README.md task that captures local Wrangler validation, required Cloudflare resources/bindings, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.',
  };
}

function generatedSliceFamilyId(taskId: string) {
  return taskId.replace(/-part-\d+$/, '');
}

function generatedSliceRank(taskId: string) {
  const match = taskId.match(/-part-(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function generatedSliceFinalByMember(taskPlan: TaskPlan) {
  const families = new Map<string, Task[]>();
  for (const task of taskPlan.tasks) {
    const familyId = generatedSliceFamilyId(task.id);
    const tasks = families.get(familyId) ?? [];
    tasks.push(task);
    families.set(familyId, tasks);
  }

  const finalByMember = new Map<string, string>();
  for (const [familyId, tasks] of families.entries()) {
    if (!tasks.some((task) => task.id !== familyId)) continue;
    const finalTask = [...tasks].sort((left, right) => generatedSliceRank(right.id) - generatedSliceRank(left.id))[0];
    if (!finalTask) continue;
    for (const task of tasks) finalByMember.set(task.id, finalTask.id);
  }

  return finalByMember;
}

export function normalizeTaskPlanGeneratedSliceDependencies(taskPlan: TaskPlan): TaskPlan {
  const finalByMember = generatedSliceFinalByMember(taskPlan);
  if (!finalByMember.size) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    const depends_on = Array.from(
      new Set(
        task.depends_on.map((dependency) => {
          const finalDependency = finalByMember.get(dependency);
          if (!finalDependency || finalDependency === dependency) return dependency;
          if (generatedSliceFamilyId(dependency) === taskFamilyId) return dependency;
          if (!taskCanSafelyDependOn(taskPlan, task.id, finalDependency)) return dependency;

          changed = true;
          return finalDependency;
        }),
      ),
    );

    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

function allTaskAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return taskPlan.tasks.flatMap((task) =>
    taskAcceptanceContractCriteria(task).map((criterion, index) => ({
      taskId: task.id,
      sourceTaskId: taskSourceTaskId(task),
      contractId: acceptanceContractId(task, index),
      criterion,
    })),
  );
}

function generatedSliceAcceptanceCriterion(criterion: string) {
  const normalized = criterion.trim();
  return (
    /^Implement delivery slice \d+\/\d+:/i.test(normalized) ||
    /^Replace any preflight stubs for this slice with real implementation code before returning\.?$/i.test(normalized) ||
    /^Keep this slice compatible with previously completed delivery slices and npm run typecheck\.?$/i.test(normalized)
  );
}

function allProductAcceptanceContractCriteria(taskPlan: TaskPlan) {
  return allTaskAcceptanceContractCriteria(taskPlan).filter(
    (contract) => !generatedSliceAcceptanceCriterion(contract.criterion),
  );
}

function revisedPlanCarriesCriterion(taskPlan: TaskPlan, criterion: string) {
  return taskPlan.tasks.some((task) => taskAcceptanceContractCriteria(task).includes(criterion));
}

function revisedContractTargetIndex(tasks: Task[], contract: { taskId: string; sourceTaskId: string }) {
  const exact = tasks.findIndex((task) => task.id === contract.taskId);
  if (exact >= 0) return exact;

  const sourceMatch = tasks.findIndex((task) => taskSourceTaskId(task) === contract.sourceTaskId);
  if (sourceMatch >= 0) return sourceMatch;

  const familyId = generatedSliceFamilyId(contract.taskId);
  return tasks.findIndex((task) => generatedSliceFamilyId(task.id) === familyId);
}

export function preserveTaskPlanAcceptanceContracts(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );
  if (!missing.length) return { taskPlan: revisedTaskPlan, carried: 0 };

  const tasks = revisedTaskPlan.tasks.map((task) => ({
    ...task,
    source_acceptance_criteria: task.source_acceptance_criteria ? [...task.source_acceptance_criteria] : undefined,
  }));
  let carried = 0;

  for (const contract of missing) {
    const targetIndex = revisedContractTargetIndex(tasks, contract);
    if (targetIndex < 0) continue;

    const target = tasks[targetIndex];
    if (taskAcceptanceContractCriteria(target).includes(contract.criterion)) continue;

    tasks[targetIndex] = {
      ...target,
      source_acceptance_criteria: Array.from(
        new Set([...(target.source_acceptance_criteria ?? []), contract.criterion]),
      ),
    };
    carried += 1;
  }

  return carried ? { taskPlan: { ...revisedTaskPlan, tasks }, carried } : { taskPlan: revisedTaskPlan, carried: 0 };
}

export function taskPlanAcceptanceContractRegression(previousTaskPlan: TaskPlan, revisedTaskPlan: TaskPlan) {
  const missing = allProductAcceptanceContractCriteria(previousTaskPlan).filter(
    (contract) => !revisedPlanCarriesCriterion(revisedTaskPlan, contract.criterion),
  );

  if (!missing.length) return { passed: true, reason: 'ok' };

  const examples = missing
    .slice(0, 5)
    .map((contract) => `${contract.taskId}/${contract.contractId}: ${contract.criterion}`)
    .join(' | ');
  const suffix = missing.length > 5 ? `; ${missing.length - 5} more contract(s) omitted` : '';
  return {
    passed: false,
    reason: `Task plan revision dropped acceptance contract(s) from the prior plan. Preserve each criterion verbatim in acceptance_criteria or source_acceptance_criteria when splitting/refining tasks: ${examples}${suffix}`,
  };
}

export function generatedSliceDependencyHygiene(taskPlan: TaskPlan) {
  const finalByMember = generatedSliceFinalByMember(taskPlan);
  if (!finalByMember.size) return { passed: true, reason: 'ok' };

  for (const task of taskPlan.tasks) {
    const taskFamilyId = generatedSliceFamilyId(task.id);
    for (const dependency of task.depends_on) {
      const finalDependency = finalByMember.get(dependency);
      if (!finalDependency || finalDependency === dependency) continue;
      if (generatedSliceFamilyId(dependency) === taskFamilyId) continue;
      if (!taskCanSafelyDependOn(taskPlan, task.id, finalDependency)) continue;

      return {
        passed: false,
        reason: `${task.id} depends_on ${dependency}, but ${dependency} is an intermediate generated slice. Depend on ${finalDependency} so downstream work waits for the complete slice family before consuming it.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
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
        'Target repo has no package.json. The task plan needs a root scaffold task that owns package.json, .gitignore, and a concrete Worker source entry before Worker runtime files so automated verification can run.',
    };
  }

  if (!ownsWorkerSourceInputSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns package.json but no Worker source input. Bare Worker scaffolds need an owned source surface such as src/index.js, workers/app.js, or src/index.ts before later tasks.`,
    };
  }

  if (ownsTypeScriptInputSurface(scaffoldRootTask) && !ownsExactSurface(scaffoldRootTask, 'tsconfig.json')) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns TypeScript Worker source but not tsconfig.json. TypeScript Worker scaffolds need tsconfig.json so npm run typecheck can pass before later tasks.`,
    };
  }

  if (!releaseGateWorkerConfigPath(repoPath) && !ownsWorkerConfigSurface(scaffoldRootTask)) {
    return {
      passed: false,
      reason: `${scaffoldRootTask.id} owns the new Worker package scaffold but not wrangler.jsonc. New Worker scaffolds should include wrangler.jsonc in the root task so the first build slice can run Wrangler dry-run validation before downstream runtime tasks.`,
    };
  }

  const plannedTomlConfig = taskPlan.tasks.find((task) => ownsExactSurface(task, 'wrangler.toml'));
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

function normalizeTaskPlanForDelivery(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  return normalizeTaskPlanOperatorDocumentation(
    normalizeTaskPlanCloudflareWorkerContracts(
      normalizeTaskPlanGeneratedSliceDependencies(
        normalizeTaskPlanLargeStorageTasks(
          normalizeTaskPlanConfigSchemaTasks(
            normalizeTaskPlanRoleBoundaries(
              normalizeTaskPlanProfileContractDependencies(normalizeTaskPlanScaffoldDependencies(repoPath, taskPlan)),
            ),
          ),
        ),
      ),
    ),
  );
}

const taskPlanDeterministicResults = ({
  repoPath,
  taskPlan,
  sourcePolicy,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  sourcePolicy?: SourcePolicy;
}): DeterministicGateResult[] => [
  { id: 'tasks_structurally_complete', check: 'plan_schema_complete', ...planSchemaComplete(taskPlan) },
  { id: 'no_circular_dependencies', check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(taskPlan) },
  { id: 'open_decisions_hygiene', check: 'open_decision_hygiene', ...openDecisionHygiene(taskPlan) },
  { id: 'owned_surfaces_concrete', check: 'owned_surface_hygiene', ...ownedSurfaceHygiene(taskPlan) },
  { id: 'owned_surfaces_match_roles', check: 'task_owned_surfaces_in_role_boundary', ...taskOwnedSurfaceRoleHygiene(taskPlan) },
  { id: 'pages_functions_source_declared', check: 'pages_functions_exception', ...pagesFunctionsExceptionHygiene(taskPlan, sourcePolicy) },
  { id: 'root_project_scaffolded', check: 'project_scaffold_hygiene', ...projectScaffoldHygiene(repoPath, taskPlan) },
  { id: 'config_schema_tasks_split', check: 'config_schema_task_split_hygiene', ...configSchemaTaskSplitHygiene(taskPlan) },
  { id: 'operator_documentation_planned', check: 'operator_documentation_hygiene', ...operatorDocumentationHygiene(taskPlan) },
  {
    id: 'generated_slice_dependencies_finalized',
    check: 'generated_slice_dependency_hygiene',
    ...generatedSliceDependencyHygiene(taskPlan),
  },
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

export function isTrueBlockingAmbiguity(question: string) {
  if (looksLikeSettledDeliveryPolicy(question)) return false;
  if (looksLikeSafeAssumptionOrRisk(question)) return false;
  const namesBlockingImpact =
    /\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible|missing required)\b/i.test(
      question,
    );
  if (!namesBlockingImpact) return false;

  return /\b(?:vision|spec|source docs?|requirements?|explicitly|TBD|not specified|missing required|omits required|unprovided|unavailable)\b/i.test(
    question,
  );
}

export const shouldSuspendForPlannerQuestions = (readout: z.infer<typeof readoutSchema>, taskPlan: TaskPlan) =>
  readout.blocking_ambiguities.some(isTrueBlockingAmbiguity) && !hasExecutableRootTask(taskPlan);

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

export function implementationActionableJudgmentRemediation(judgment: AggregatedJudgment, task?: Task) {
  const nonActionableDimensionIds = new Set(
    judgment.dimensions_scored
      .filter((dimension) => dimension.score <= 3)
      .filter((dimension) => weakDimensionIsNonActionableForTask(dimension, task))
      .map((dimension) => dimension.id),
  );

  return judgment.remediation.filter((item) => {
    for (const dimensionId of nonActionableDimensionIds) {
      if (item.startsWith(`DIMENSION ${dimensionId} `)) return false;
    }
    return true;
  });
}

function implementationFindingSteps(taskId: string, judgment: AggregatedJudgment, task?: Task) {
  const remediation = [
    ...implementationActionableJudgmentRemediation(judgment, task),
    ...implementationWeakDimensionRemediation(judgment, task),
  ];
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
  if (judgment.gates_failed.length || judgment.dimensions_missing.length) return false;
  if (implementationActionableJudgmentRemediation(judgment, task).length) return false;
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
    .filter((path): path is string => typeof path === 'string' && !/^unknown:/i.test(path));
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

function taskBoundaryCanConfigureWorkersAi(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some(
      (path) =>
        ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path) || workerSourceSurfaceIsConcrete(path),
    );
}

function workerSourceSearchRoots(repoPath: string) {
  const root = resolve(repoPath);
  return [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.js'),
    join(root, 'worker.mjs'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];
}

function sourceTextContainsRouteLiteral(text: string, route: string) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp("(['\"`])" + escaped + '\\1').test(text);
}

function sourceTreeContainsRouteLiteral(rootPath: string, route: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return sourceTextContainsRouteLiteral(readFileSync(rootPath, 'utf8'), route);
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeContainsRouteLiteral(path, route, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (sourceTextContainsRouteLiteral(readFileSync(path, 'utf8'), route)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function workerSourceContainsRouteLiteral(repoPath: string, route: string) {
  const scanned = { count: 0 };
  return workerSourceSearchRoots(repoPath).some((sourceRoot) => sourceTreeContainsRouteLiteral(sourceRoot, route, scanned));
}

function sourceTextUsesWorkersAi(text: string) {
  return [
    /\benv\s*\??\.\s*AI\b/,
    /\benv\s*\[\s*['"]AI['"]\s*\]/,
    /\bconst\s*\{[^}]*\bAI\b[^}]*\}\s*=\s*(?:\w+\.)?env\b/,
    /\b(?:const|let|var)\s+\w+\s*=\s*(?:\w+\.)?env\s*\??\.\s*AI\b/,
    /\bAI\s*\??\s*:\s*Ai\b/,
    /\bAI\s*\.\s*run\s*\(/,
    /\bWorkersAiClient\b/,
    /\bcreateAiClient\b/,
    /\bfrom\s+['"](?:\.{1,2}\/)*ai\/client['"]/,
  ].some((pattern) => pattern.test(text));
}

function sourceTreeUsesWorkersAi(rootPath: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return sourceTextUsesWorkersAi(readFileSync(rootPath, 'utf8'));
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeUsesWorkersAi(path, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (sourceTextUsesWorkersAi(readFileSync(path, 'utf8'))) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function repoSourceUsesWorkersAi(repoPath: string) {
  const scanned = { count: 0 };
  return workerSourceSearchRoots(repoPath).some((sourceRoot) => sourceTreeUsesWorkersAi(sourceRoot, scanned));
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

function stripJsoncComments(text: string) {
  let output = '';
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length) {
        if (text[index] === '\n') output += '\n';
        if (text[index] === '*' && text[index + 1] === '/') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output += char;
  }

  return output;
}

function parseWranglerJsonConfig(text: string) {
  const withoutComments = stripJsoncComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(withoutTrailingCommas) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function tomlArrayStringValues(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function firstTomlBooleanValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'm').exec(text);
  return match ? match[1] === 'true' : undefined;
}

function firstTomlNumberValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm').exec(text);
  return match ? Number(match[1]) : undefined;
}

function tomlSectionBody(text: string, sectionName: string) {
  const lines = text.split(/\r?\n/);
  const body: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      if (inSection) break;
      inSection = section[1] === sectionName;
      continue;
    }

    if (inSection) body.push(line);
  }

  return inSection || body.length ? body.join('\n') : undefined;
}

function isoDateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }

  return { year, month, day, time };
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function workerConfigTaskPacketPolicy() {
  return {
    schema: './node_modules/wrangler/config-schema.json',
    compatibility_date: todayIsoDate(),
    compatibility_flags: ['nodejs_compat'],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    static_assets: {
      when_public_directory_exists: {
        directory: './public',
        binding: 'ASSETS',
      },
    },
    deployment_environments: {
      required: ['staging', 'production'],
      staging_dev_command: 'wrangler dev --env staging',
      staging_d1_migration_command: 'wrangler d1 migrations apply <database> --env staging --local',
      production_dry_run_command: 'wrangler deploy --dry-run --env production',
      production_deploy_command: 'wrangler deploy --env production',
      note: 'Wrangler bindings and vars are non-inheritable, so mirror required binding names and required vars inside env.staging and env.production.',
    },
    generated_types: {
      command: 'wrangler types',
      output: 'worker-configuration.d.ts',
      tsconfig_types: ['./worker-configuration.d.ts', 'node'],
    },
  };
}

export function workerConfigTaskPacketPolicyForTask(task: Task) {
  return taskOwnsWorkerConfigFile(task) ? workerConfigTaskPacketPolicy() : null;
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

function workerCompatibilityDateGaps(value: unknown) {
  if (typeof value !== 'string') {
    return [`compatibility_date is missing; set it to today's date (${todayIsoDate()}) for new Worker projects.`];
  }

  const parsed = isoDateParts(value);
  if (!parsed) {
    return [`compatibility_date "${value}" is not a valid YYYY-MM-DD date.`];
  }

  const today = isoDateParts(todayIsoDate());
  if (!today) return [];

  const ageDays = Math.floor((today.time - parsed.time) / 86_400_000);
  if (ageDays < 0) {
    return [`compatibility_date "${value}" is in the future; use today's date (${todayIsoDate()}) or a recent released date.`];
  }
  if (ageDays > 30) {
    return [
      `compatibility_date "${value}" is stale by ${ageDays} days; set it to today's date (${todayIsoDate()}) or a date within the last 30 days.`,
    ];
  }

  return [];
}

function observabilityConfigGaps(observability: Record<string, unknown> | undefined) {
  const gaps: string[] = [];
  if (!observability) {
    return ['observability is missing; enable Worker observability explicitly with enabled=true and a head_sampling_rate.'];
  }

  if (observability.enabled !== true) {
    gaps.push('observability.enabled must be true for Worker logs/traces.');
  }

  const samplingRate = observability.head_sampling_rate;
  if (typeof samplingRate !== 'number' || !Number.isFinite(samplingRate) || samplingRate <= 0 || samplingRate > 1) {
    gaps.push('observability.head_sampling_rate must be an explicit number greater than 0 and at most 1.');
  }

  return gaps;
}

function workerNameGaps(name: unknown) {
  if (typeof name !== 'string' || !name.trim()) {
    return ['name is missing; set it to the Cloudflare Worker service name used by Wrangler.'];
  }

  if (name !== name.trim()) {
    return [`name "${name}" has leading or trailing whitespace; use "${name.trim()}".`];
  }

  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return [`name "${name}" must be a single Worker service name using only letters, numbers, underscores, and hyphens.`];
  }

  return [];
}

function workerMainEntrypointGaps(repoPath: string, main: unknown) {
  if (typeof main !== 'string' || !main.trim()) {
    return ['main is missing; set it to the Worker entrypoint file used by Wrangler local validation.'];
  }

  const normalized = normalizeDeliveryPathReference(main);
  if (!normalized || isAbsolute(normalized)) {
    return [`main "${main}" must be a repo-relative Worker entrypoint path.`];
  }

  if (!existsSync(join(resolve(repoPath), normalized))) {
    return [`main "${normalized}" does not exist; Wrangler local validation would start the wrong or missing Worker entrypoint.`];
  }

  return [];
}

function taskBoundaryCanConfigureWorkerConfig(repoPath: string, task: Task) {
  return taskBoundarySurfaces(repoPath, task)
    .map(concreteOwnedSurfacePath)
    .filter((path): path is string => Boolean(path))
    .some((path) => ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'].includes(path));
}

function relativeWorkerConfigPath(repoPath: string, configPath: string) {
  const root = resolve(repoPath);
  return configPath.startsWith(`${root}/`) ? configPath.slice(root.length + 1) : configPath;
}

function repoLooksLikeWorkerProject(repoPath: string) {
  const root = resolve(repoPath);
  const packageJson = packageRecord(repoPath);
  const scripts = recordValue(packageJson?.scripts) ?? {};
  return (
    Boolean(releaseGateWorkerConfigPath(repoPath)) ||
    existsSync(join(root, 'src', 'index.ts')) ||
    existsSync(join(root, 'src', 'index.js')) ||
    existsSync(join(root, 'src', 'index.mjs')) ||
    existsSync(join(root, 'src', 'env.ts')) ||
    existsSync(join(root, 'worker.js')) ||
    existsSync(join(root, 'worker.mjs')) ||
    existsSync(join(root, 'workers')) ||
    existsSync(join(root, 'worker-configuration.d.ts')) ||
    (typeof scripts.dev === 'string' && /\bwrangler\s+dev\b/.test(scripts.dev)) ||
    packageDependencyNames(repoPath).includes('wrangler')
  );
}

type WorkerBindingKind =
  | 'ai'
  | 'assets'
  | 'd1'
  | 'durable_object'
  | 'hyperdrive'
  | 'kv'
  | 'queue'
  | 'r2'
  | 'service'
  | 'vectorize'
  | 'workflow';

interface WorkerBindingDeclaration {
  name: string;
  kind: WorkerBindingKind;
  source: string;
}

function workerEnvBindingKind(name: string, typeText: string): WorkerBindingKind | undefined {
  if (/\bAi\b/.test(typeText)) return 'ai';
  if (name === 'ASSETS' && /\bFetcher\b/.test(typeText)) return 'assets';
  if (/\bD1Database\b/.test(typeText)) return 'd1';
  if (/\bDurableObjectNamespace\b/.test(typeText)) return 'durable_object';
  if (/\bFetcher\b|\bService\b/.test(typeText)) return 'service';
  if (/\bHyperdrive\b/.test(typeText)) return 'hyperdrive';
  if (/\bKVNamespace\b/.test(typeText)) return 'kv';
  if (/\bQueue\b/.test(typeText)) return 'queue';
  if (/\bR2Bucket\b/.test(typeText)) return 'r2';
  if (/\bVectorizeIndex\b/.test(typeText)) return 'vectorize';
  if (/\bWorkflow\b/.test(typeText)) return 'workflow';
  return undefined;
}

function workerEnvSourcePath(repoPath: string) {
  return ['worker-configuration.d.ts', 'src/env.ts', 'src/index.ts']
    .map((path) => join(resolve(repoPath), path))
    .find((path) => existsSync(path));
}

function workerEnvBindingDeclarations(repoPath: string): WorkerBindingDeclaration[] {
  const envPath = workerEnvSourcePath(repoPath);
  if (!envPath) return [];

  const source = readFileSync(envPath, 'utf8');
  const body = source.match(/\b(?:export\s+)?interface\s+Env\s*\{([\s\S]*?)\n?\}/)?.[1];
  if (!body) return [];

  return Array.from(body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/gm)).flatMap(
    (match) => {
      const name = match[1];
      const kind = workerEnvBindingKind(name, match[2]);
      return kind ? [{ name, kind, source: relativeWorkerConfigPath(repoPath, envPath) }] : [];
    },
  );
}

function pushJsonBinding(
  declarations: WorkerBindingDeclaration[],
  value: unknown,
  kind: WorkerBindingKind,
  key: 'binding' | 'name' = 'binding',
) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = recordValue(item);
    const name = record?.[key];
    if (typeof name === 'string' && name.trim()) {
      declarations.push({ name, kind, source: 'wrangler config' });
    }
  }
}

function workerJsonConfigBindingDeclarations(config: Record<string, unknown>): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];

  const ai = recordValue(config.ai);
  if (typeof ai?.binding === 'string' && ai.binding.trim()) {
    declarations.push({ name: ai.binding, kind: 'ai', source: 'wrangler config' });
  }

  const assets = recordValue(config.assets);
  if (typeof assets?.binding === 'string' && assets.binding.trim()) {
    declarations.push({ name: assets.binding, kind: 'assets', source: 'wrangler config' });
  }

  pushJsonBinding(declarations, config.d1_databases, 'd1');
  pushJsonBinding(declarations, config.durable_objects && recordValue(config.durable_objects)?.bindings, 'durable_object', 'name');
  pushJsonBinding(declarations, config.hyperdrive, 'hyperdrive');
  pushJsonBinding(declarations, config.kv_namespaces, 'kv');
  pushJsonBinding(declarations, config.r2_buckets, 'r2');
  pushJsonBinding(declarations, config.services, 'service');
  pushJsonBinding(declarations, config.vectorize, 'vectorize');
  pushJsonBinding(declarations, config.workflows, 'workflow');

  const queues = recordValue(config.queues);
  pushJsonBinding(declarations, queues?.producers, 'queue');

  return declarations;
}

function workerJsonConfigVarNames(config: Record<string, unknown>) {
  const vars = recordValue(config.vars);
  return vars ? Object.keys(vars).filter(Boolean) : [];
}

function workerJsonEnvironmentRecord(config: Record<string, unknown>, environmentName: string) {
  return recordValue(recordValue(config.env)?.[environmentName]);
}

function workerJsonHasEnvironment(config: Record<string, unknown>, environmentName: string) {
  return Boolean(workerJsonEnvironmentRecord(config, environmentName));
}

function tomlArrayTableBodies(text: string, tableName: string) {
  const bodies: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] | undefined;

  for (const line of lines) {
    const arrayTable = line.match(/^\s*\[\[([^\]]+)\]\]\s*$/);
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (arrayTable || table) {
      if (current) bodies.push(current.join('\n'));
      current = arrayTable?.[1] === tableName ? [] : undefined;
      continue;
    }

    if (current) current.push(line);
  }

  if (current) bodies.push(current.join('\n'));
  return bodies;
}

function pushTomlBindings(
  declarations: WorkerBindingDeclaration[],
  text: string,
  tableName: string,
  kind: WorkerBindingKind,
  key = 'binding',
) {
  for (const body of tomlArrayTableBodies(text, tableName)) {
    const name = firstTomlStringValue(body, key);
    if (name) declarations.push({ name, kind, source: 'wrangler config' });
  }
}

function workerTomlConfigBindingDeclarations(text: string): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];

  const aiBody = tomlSectionBody(text, 'ai');
  const aiBinding = aiBody ? firstTomlStringValue(aiBody, 'binding') : undefined;
  if (aiBinding) declarations.push({ name: aiBinding, kind: 'ai', source: 'wrangler config' });

  const assetsBody = tomlSectionBody(text, 'assets');
  const assetsBinding = assetsBody ? firstTomlStringValue(assetsBody, 'binding') : undefined;
  if (assetsBinding) declarations.push({ name: assetsBinding, kind: 'assets', source: 'wrangler config' });

  pushTomlBindings(declarations, text, 'd1_databases', 'd1');
  pushTomlBindings(declarations, text, 'durable_objects.bindings', 'durable_object', 'name');
  pushTomlBindings(declarations, text, 'hyperdrive', 'hyperdrive');
  pushTomlBindings(declarations, text, 'kv_namespaces', 'kv');
  pushTomlBindings(declarations, text, 'queues.producers', 'queue');
  pushTomlBindings(declarations, text, 'r2_buckets', 'r2');
  pushTomlBindings(declarations, text, 'services', 'service');
  pushTomlBindings(declarations, text, 'vectorize', 'vectorize');
  pushTomlBindings(declarations, text, 'workflows', 'workflow');

  return declarations;
}

function workerTomlEnvironmentBindingDeclarations(text: string, environmentName: string): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];
  const prefix = `env.${environmentName}`;

  const aiBody = tomlSectionBody(text, `${prefix}.ai`);
  const aiBinding = aiBody === undefined ? undefined : firstTomlStringValue(aiBody, 'binding');
  if (aiBinding) declarations.push({ name: aiBinding, kind: 'ai', source: `env.${environmentName} Wrangler config` });

  const assetsBody = tomlSectionBody(text, `${prefix}.assets`);
  const assetsBinding = assetsBody === undefined ? undefined : firstTomlStringValue(assetsBody, 'binding');
  if (assetsBinding) {
    declarations.push({ name: assetsBinding, kind: 'assets', source: `env.${environmentName} Wrangler config` });
  }

  pushTomlBindings(declarations, text, `${prefix}.d1_databases`, 'd1');
  pushTomlBindings(declarations, text, `${prefix}.durable_objects.bindings`, 'durable_object', 'name');
  pushTomlBindings(declarations, text, `${prefix}.hyperdrive`, 'hyperdrive');
  pushTomlBindings(declarations, text, `${prefix}.kv_namespaces`, 'kv');
  pushTomlBindings(declarations, text, `${prefix}.queues.producers`, 'queue');
  pushTomlBindings(declarations, text, `${prefix}.r2_buckets`, 'r2');
  pushTomlBindings(declarations, text, `${prefix}.services`, 'service');
  pushTomlBindings(declarations, text, `${prefix}.vectorize`, 'vectorize');
  pushTomlBindings(declarations, text, `${prefix}.workflows`, 'workflow');

  return declarations;
}

function tomlSectionKeyNames(text: string, sectionName: string) {
  const body = tomlSectionBody(text, sectionName);
  if (body === undefined) return [];
  return Array.from(body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=/gm)).map((match) => match[1]);
}

function tomlHasEnvironment(text: string, environmentName: string) {
  const escaped = environmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\[?env\\.${escaped}(?:\\.|\\])`, 'm').test(text);
}

function workerConfigBindingDeclarations(repoPath: string): WorkerBindingDeclaration[] {
  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) return [];

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return workerTomlConfigBindingDeclarations(text);

  const config = parseWranglerJsonConfig(text);
  return config ? workerJsonConfigBindingDeclarations(config) : [];
}

export function workerEnvBindingAlignmentGaps(repoPath: string) {
  const envBindings = workerEnvBindingDeclarations(repoPath);
  if (!envBindings.length || !releaseGateWorkerConfigPath(repoPath)) return [];

  const configBindings = workerConfigBindingDeclarations(repoPath);
  const configKeySet = new Set(configBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const envKeySet = new Set(envBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const gaps: string[] = [];

  for (const binding of envBindings) {
    if (configKeySet.has(`${binding.kind}:${binding.name}`)) continue;
    gaps.push(
      `${binding.source} declares ${binding.name} as a ${binding.kind} binding, but Wrangler config has no matching ${binding.kind} binding named "${binding.name}". Use identical binding names across Env and Wrangler config.`,
    );
  }

  for (const binding of configBindings) {
    if (envKeySet.has(`${binding.kind}:${binding.name}`)) continue;
    gaps.push(
      `Wrangler config declares ${binding.name} as a ${binding.kind} binding, but src/env.ts has no matching ${binding.kind} Env property named "${binding.name}". Use identical binding names across Env and Wrangler config.`,
    );
  }

  return gaps;
}

const workerDeploymentEnvironments = ['staging', 'production'] as const;

function workerEnvironmentMirrorGaps({
  environmentName,
  topLevelBindings,
  environmentBindings,
  topLevelVars,
  environmentVars,
}: {
  environmentName: string;
  topLevelBindings: WorkerBindingDeclaration[];
  environmentBindings: WorkerBindingDeclaration[];
  topLevelVars: string[];
  environmentVars: string[];
}) {
  const gaps: string[] = [];
  const environmentBindingKeys = new Set(environmentBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const environmentVarSet = new Set(environmentVars);

  for (const binding of topLevelBindings) {
    if (environmentBindingKeys.has(`${binding.kind}:${binding.name}`)) continue;
    const article = /^[aeiou]/i.test(binding.kind) ? 'an' : 'a';
    gaps.push(
      `env.${environmentName} must declare ${binding.name} as ${article} ${binding.kind} binding because Wrangler bindings are non-inheritable across environments.`,
    );
  }

  for (const varName of topLevelVars) {
    if (environmentVarSet.has(varName)) continue;
    gaps.push(
      `env.${environmentName}.vars must declare ${varName} because Wrangler vars are non-inheritable across environments.`,
    );
  }

  return gaps;
}

function workerJsonDeploymentEnvironmentGaps(config: Record<string, unknown>) {
  const gaps: string[] = [];
  const topLevelBindings = workerJsonConfigBindingDeclarations(config);
  const topLevelVars = workerJsonConfigVarNames(config);

  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (!environment) {
      gaps.push(
        `env.${environmentName} is missing; define a Wrangler ${environmentName} environment so local validation, preview/staging, and human-approved production deploys have explicit targets.`,
      );
      continue;
    }

    gaps.push(
      ...workerEnvironmentMirrorGaps({
        environmentName,
        topLevelBindings,
        environmentBindings: workerJsonConfigBindingDeclarations(environment),
        topLevelVars,
        environmentVars: workerJsonConfigVarNames(environment),
      }),
    );
  }

  return gaps;
}

function workerTomlDeploymentEnvironmentGaps(text: string) {
  const gaps: string[] = [];
  const topLevelBindings = workerTomlConfigBindingDeclarations(text);
  const topLevelVars = tomlSectionKeyNames(text, 'vars');

  for (const environmentName of workerDeploymentEnvironments) {
    if (!tomlHasEnvironment(text, environmentName)) {
      gaps.push(
        `env.${environmentName} is missing; define a Wrangler ${environmentName} environment so local validation, preview/staging, and human-approved production deploys have explicit targets.`,
      );
      continue;
    }

    gaps.push(
      ...workerEnvironmentMirrorGaps({
        environmentName,
        topLevelBindings,
        environmentBindings: workerTomlEnvironmentBindingDeclarations(text, environmentName),
        topLevelVars,
        environmentVars: tomlSectionKeyNames(text, `env.${environmentName}.vars`),
      }),
    );
  }

  return gaps;
}

function workerConfigHasEnvironment(repoPath: string, environmentName: string) {
  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) return false;

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return tomlHasEnvironment(text, environmentName);

  const config = parseWranglerJsonConfig(text);
  return config ? workerJsonHasEnvironment(config, environmentName) : false;
}

function directoryHasNonIgnoredFiles(directory: string): boolean {
  if (!existsSync(directory)) return false;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasNonIgnoredFiles(entryPath)) return true;
      continue;
    }
    if (entry.isFile()) return true;
  }

  return false;
}

function repoHasPublicStaticAssets(repoPath: string) {
  return directoryHasNonIgnoredFiles(join(resolve(repoPath), 'public'));
}

function assetDirectoryIsPublic(value: unknown) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '');
  return normalized === 'public';
}

function workerStaticAssetsGaps(repoPath: string, assetsConfig: Record<string, unknown> | undefined) {
  if (!repoHasPublicStaticAssets(repoPath)) return [];
  if (!assetsConfig) {
    return [
      'assets is missing; public/ UI files must be deployed through Workers Static Assets with assets.directory="./public" and binding="ASSETS".',
    ];
  }

  const gaps: string[] = [];
  if (!assetDirectoryIsPublic(assetsConfig.directory)) {
    gaps.push('assets.directory must be "./public" so Wrangler uploads the vanilla public/ UI with the Worker.');
  }
  if (assetsConfig.binding !== 'ASSETS') {
    gaps.push('assets.binding must be "ASSETS" so Worker code can fall back to env.ASSETS.fetch(request) when needed.');
  }

  return gaps;
}

export function workerConfigHygieneGaps(repoPath: string, task?: Task) {
  if (task && !taskBoundaryCanConfigureWorkerConfig(repoPath, task)) return [];

  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) {
    if (task) return ['Worker config surface is owned, but no Wrangler config file exists.'];
    return repoLooksLikeWorkerProject(repoPath)
      ? ['No Wrangler config file exists for this Worker project; add wrangler.jsonc with Worker entrypoint, compatibility_date, bindings, and observability before release.']
      : [];
  }

  const configName = relativeWorkerConfigPath(repoPath, configPath);
  const text = readFileSync(configPath, 'utf8');
  const gaps: string[] = [];

  if (configPath.endsWith('.toml')) {
    gaps.push(...workerNameGaps(firstTomlStringValue(text, 'name')));
    gaps.push(...workerMainEntrypointGaps(repoPath, firstTomlStringValue(text, 'main')));
    gaps.push(...workerCompatibilityDateGaps(firstTomlStringValue(text, 'compatibility_date')));
    if (!tomlArrayStringValues(text, 'compatibility_flags').includes('nodejs_compat')) {
      gaps.push('compatibility_flags must include "nodejs_compat" so Wrangler provides Node.js compatibility for npm packages.');
    }

    const observability = tomlSectionBody(text, 'observability');
    if (!observability) {
      gaps.push('observability is missing; add [observability] with enabled=true and head_sampling_rate.');
    } else {
      gaps.push(
        ...observabilityConfigGaps({
          enabled: firstTomlBooleanValue(observability, 'enabled'),
          head_sampling_rate: firstTomlNumberValue(observability, 'head_sampling_rate'),
        }),
      );
    }

    const assets = tomlSectionBody(text, 'assets');
    gaps.push(
      ...workerStaticAssetsGaps(
        repoPath,
        assets
          ? {
              directory: firstTomlStringValue(assets, 'directory'),
              binding: firstTomlStringValue(assets, 'binding'),
            }
          : undefined,
      ),
    );
    gaps.push(...workerTomlDeploymentEnvironmentGaps(text));
    gaps.push(...workerEnvBindingAlignmentGaps(repoPath));

    return gaps.map((gap) => `${configName}: ${gap}`);
  }

  const config = parseWranglerJsonConfig(text);
  if (!config) return [`${configName}: config is not valid JSONC that can be parsed for Worker config hygiene.`];

  if (config.$schema !== './node_modules/wrangler/config-schema.json') {
    gaps.push('$schema must be "./node_modules/wrangler/config-schema.json" so Wrangler/editor validation resolves locally.');
  }

  gaps.push(...workerNameGaps(config.name));
  gaps.push(...workerMainEntrypointGaps(repoPath, config.main));
  gaps.push(...workerCompatibilityDateGaps(config.compatibility_date));

  if (!stringArrayValue(config.compatibility_flags).includes('nodejs_compat')) {
    gaps.push('compatibility_flags must include "nodejs_compat" so Wrangler provides Node.js compatibility for npm packages.');
  }

  gaps.push(...observabilityConfigGaps(recordValue(config.observability)));
  gaps.push(...workerStaticAssetsGaps(repoPath, recordValue(config.assets)));
  gaps.push(...workerJsonDeploymentEnvironmentGaps(config));
  gaps.push(...workerEnvBindingAlignmentGaps(repoPath));

  return gaps.map((gap) => `${configName}: ${gap}`);
}

export function wranglerConfigHasWorkersAiBinding(repoPath: string) {
  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) return false;
  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return wranglerTomlHasWorkersAiBinding(text);
  return wranglerJsonHasWorkersAiBinding(text);
}

function workerEnvMarksAiOptional(repoPath: string) {
  const root = resolve(repoPath);
  const sourceRoots = [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];

  return sourceRoots.some((sourceRoot) => sourceTreeContainsText(sourceRoot, 'AI?: Ai', { count: 0 }));
}

export function workersAiBindingGaps(repoPath: string, task?: Task) {
  if (!repoSourceUsesWorkersAi(repoPath)) return [];
  if (task && !taskBoundaryCanConfigureWorkersAi(repoPath, task)) return [];

  const gaps: string[] = [];
  if (!wranglerConfigHasWorkersAiBinding(repoPath)) {
    gaps.push(
      'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML).',
    );
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

function surfaceLooksLikeWorkerEntrypoint(path: string) {
  return (
    /^worker\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path) ||
    /^src\/index\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path) ||
    /^workers\/.+\.(?:js|mjs|cjs|ts|mts|cts)$/.test(path)
  );
}

function compileSafeStubForSurface(path: string) {
  if (surfaceLooksLikeWorkerEntrypoint(path)) {
    return [
      `// ${deliveryPreflightStubMarker}. The implementation agent should replace this with task code.`,
      'export default {',
      '  fetch() {',
      '    return Response.json({ status: "preflight_stub" });',
      '  },',
      '};',
      '',
    ].join('\n');
  }

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

function packageRecord(repoPath: string) {
  return recordValue(readJsonArtifact(repoPath, 'package.json'));
}

function packageDependencyVersion(packageJson: Record<string, unknown>, name: string) {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = recordValue(packageJson[key]);
    const version = bucket?.[name];
    if (typeof version === 'string') return version;
  }
  return undefined;
}

function dependencyRangeMajor(version: string) {
  const match = /(?:^|[^\d])(\d+)(?:\.\d+)?/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

function dependencyRangeAllowsWranglerV4(version: string) {
  const normalized = version.trim().toLowerCase();
  if (normalized === 'latest') return true;
  const major = dependencyRangeMajor(normalized);
  return major !== undefined && major >= 4;
}

function wranglerScriptCommandTail(script: unknown, command: 'dev' | 'deploy') {
  if (typeof script !== 'string') return undefined;
  const match = new RegExp(`\\bwrangler\\s+${command}\\b([^;&|\\n]*)`).exec(script);
  return match ? (match[1] ?? '') : undefined;
}

function commandTailUsesEnvironment(commandTail: string, environmentName: string) {
  const escaped = environmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:--env(?:=|\\s+)|-e(?:=|\\s+))${escaped}(?:\\s|$)`).test(commandTail);
}

function commandTailHasEntrypoint(commandTail: string) {
  return /(^|\s)(?:\.\/)?(?:(?:src|workers)\/\S+\.(?:js|mjs|cjs|ts|tsx|mts|cts)|worker\.(?:js|mjs|cjs|ts|tsx|mts|cts))(\s|$)/.test(
    commandTail,
  );
}

function scriptUsesWranglerEnvironmentWithoutEntrypoint(
  script: unknown,
  command: 'dev' | 'deploy',
  environmentName: string,
) {
  const commandTail = wranglerScriptCommandTail(script, command);
  return (
    commandTail !== undefined &&
    !commandTailHasEntrypoint(commandTail) &&
    commandTailUsesEnvironment(commandTail, environmentName)
  );
}

function scriptRunsWranglerTypes(script: unknown) {
  return typeof script === 'string' && /\bwrangler\s+types\b/.test(script);
}

function scriptRunsTypecheckWithGeneratedWorkerTypes(script: unknown) {
  if (typeof script !== 'string') return false;
  const runsTypeScript = /\btsc\s+--noEmit\b/.test(script);
  const generatesTypes = /\bwrangler\s+types\b/.test(script) || /\bnpm\s+run\s+(?:generate-types|typegen|cf-typegen)\b/.test(script);
  return runsTypeScript && generatesTypes;
}

const forbiddenFrontendPackageNames = [
  '@astrojs/cloudflare',
  '@sveltejs/kit',
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
  'astro',
  'next',
  'parcel',
  'react',
  'react-dom',
  'react-scripts',
  'rollup',
  'svelte',
  'vite',
  'vue',
  'webpack',
];

function frontendFrameworkDependencyGaps(repoPath: string) {
  const dependencies = new Set(packageDependencyNames(repoPath));
  const forbidden = forbiddenFrontendPackageNames.filter((name) => dependencies.has(name));
  return forbidden.length
    ? [
        `package.json: remove frontend framework/build dependencies (${forbidden.join(', ')}); Chris's Worker projects use vanilla HTML, CSS, and JavaScript without React, Vite, Next, Vue, or Svelte.`,
      ]
    : [];
}

function frontendBuildScriptGaps(scripts: Record<string, unknown>) {
  const buildScript = scripts.build;
  if (typeof buildScript !== 'string') return [];
  if (!/\b(vite|next|react-scripts|webpack|rollup|parcel|astro|svelte-kit)\b/i.test(buildScript)) return [];

  return [
    `package.json: scripts.build uses a frontend framework/bundler command ("${buildScript}"); Worker projects should validate with tests/Wrangler, add tsc only for TypeScript source, and serve vanilla public assets without a frontend build step.`,
  ];
}

function tsconfigWorkerScaffoldGaps(repoPath: string) {
  const tsconfigPath = join(resolve(repoPath), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return ['tsconfig.json: missing; TypeScript Worker scaffolds need a Worker-runtime TypeScript config for deterministic typecheck.'];
  }

  const config = parseWranglerJsonConfig(readFileSync(tsconfigPath, 'utf8'));
  if (!config) return ['tsconfig.json: file is not valid JSONC.'];

  const compilerOptions = recordValue(config.compilerOptions);
  if (!compilerOptions) return ['tsconfig.json: compilerOptions is missing.'];

  const gaps: string[] = [];
  const target = typeof compilerOptions.target === 'string' ? compilerOptions.target.toLowerCase() : '';
  if (!/^es(?:202[2-9]|next)$/.test(target)) {
    gaps.push('tsconfig.json: compilerOptions.target should be ES2022 or newer for Cloudflare Workers.');
  }

  const module = typeof compilerOptions.module === 'string' ? compilerOptions.module.toLowerCase() : '';
  if (module !== 'esnext') {
    gaps.push('tsconfig.json: compilerOptions.module should be ESNext for Worker module syntax.');
  }

  const moduleResolution =
    typeof compilerOptions.moduleResolution === 'string' ? compilerOptions.moduleResolution.toLowerCase() : '';
  if (moduleResolution !== 'bundler') {
    gaps.push('tsconfig.json: compilerOptions.moduleResolution should be Bundler for Wrangler/Worker imports.');
  }

  const libs = stringArrayValue(compilerOptions.lib).map((item) => item.toLowerCase());
  if (!libs.some((item) => /^es(?:202[2-9]|next)$/.test(item))) {
    gaps.push('tsconfig.json: compilerOptions.lib should include ES2022 or newer.');
  }
  if (!libs.includes('webworker')) {
    gaps.push('tsconfig.json: compilerOptions.lib should include WebWorker for Cloudflare Worker globals.');
  }

  const types = stringArrayValue(compilerOptions.types).map((item) => item.toLowerCase());
  if (!types.includes('./worker-configuration.d.ts') && !types.includes('worker-configuration.d.ts')) {
    gaps.push('tsconfig.json: compilerOptions.types should include ./worker-configuration.d.ts generated by wrangler types.');
  }
  if (!types.includes('node')) {
    gaps.push('tsconfig.json: compilerOptions.types should include node when nodejs_compat is enabled.');
  }

  if (compilerOptions.strict !== true) {
    gaps.push('tsconfig.json: compilerOptions.strict should be true.');
  }

  return gaps;
}

function directoryContainsTypeScriptWorkerSource(directory: string): boolean {
  if (!existsSync(directory)) return false;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['.delivery', '.git', '.wrangler', 'node_modules'].includes(entry.name)) continue;
      if (directoryContainsTypeScriptWorkerSource(entryPath)) return true;
      continue;
    }

    if (entry.isFile() && workerSourceSurfaceIsTypeScript(entry.name)) return true;
  }

  return false;
}

function repoUsesTypeScriptWorkerSource(repoPath: string, task?: Task) {
  const root = resolve(repoPath);
  return (
    (task !== undefined && (ownsTypeScriptInputSurface(task) || ownsExactSurface(task, 'tsconfig.json'))) ||
    existsSync(join(root, 'tsconfig.json')) ||
    directoryContainsTypeScriptWorkerSource(join(root, 'src')) ||
    directoryContainsTypeScriptWorkerSource(join(root, 'workers')) ||
    existsSync(join(root, 'worker.ts')) ||
    existsSync(join(root, 'worker.mts')) ||
    existsSync(join(root, 'worker.cts'))
  );
}

const workerScaffoldRequiredGitignorePatterns = ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile'];

function gitignorePatternPresent(text: string, pattern: string) {
  const directoryPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => line === pattern || line === directoryPattern);
}

function workerScaffoldGitignoreGaps(repoPath: string) {
  const gitignorePath = join(resolve(repoPath), '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [
      '.gitignore is missing; new Worker scaffolds must keep local delivery artifacts, Wrangler state, startup profiles, dependencies, and local secrets out of git.',
    ];
  }

  const text = readFileSync(gitignorePath, 'utf8');
  const missing = workerScaffoldRequiredGitignorePatterns.filter((pattern) => !gitignorePatternPresent(text, pattern));
  return missing.length
    ? [
        `.gitignore should ignore ${missing.join(', ')} so generated delivery state, local Wrangler state, startup profiles, dependencies, and local secrets stay out of git.`,
      ]
    : [];
}

export function workerPackageScaffoldGaps(repoPath: string, task?: Task) {
  if (task && !taskOwnsPackageManifest(task)) return [];

  const packageJson = packageRecord(repoPath);
  if (!packageJson) {
    if (task) return ['package.json is owned but is not valid JSON.'];
    return repoLooksLikeWorkerProject(repoPath)
      ? ['package.json is missing; Worker release requires local package scripts and a local Wrangler devDependency.']
      : [];
  }

  const gaps: string[] = [];
  const usesTypeScript = repoUsesTypeScriptWorkerSource(repoPath, task);
  const scripts = recordValue(packageJson.scripts) ?? {};
  if (!scriptUsesWranglerEnvironmentWithoutEntrypoint(scripts.dev, 'dev', 'staging')) {
    gaps.push(
      'package.json: scripts.dev should run "wrangler dev --env staging" through wrangler.jsonc, without passing a Worker source entrypoint argument.',
    );
  }
  if (!scriptUsesWranglerEnvironmentWithoutEntrypoint(scripts.deploy, 'deploy', 'production')) {
    gaps.push(
      'package.json: scripts.deploy should run "wrangler deploy --env production" through wrangler.jsonc, without passing a Worker source entrypoint argument.',
    );
  }
  if (usesTypeScript && !scriptRunsWranglerTypes(scripts['generate-types'])) {
    gaps.push(
      'package.json: scripts.generate-types should run "wrangler types" to generate worker-configuration.d.ts from Wrangler config.',
    );
  }
  if (usesTypeScript && !scriptRunsTypecheckWithGeneratedWorkerTypes(scripts.typecheck)) {
    gaps.push(
      'package.json: scripts.typecheck should run "npm run generate-types && tsc --noEmit" for deterministic Worker binding types.',
    );
  }
  gaps.push(...frontendBuildScriptGaps(scripts));

  const wranglerVersion = packageDependencyVersion(packageJson, 'wrangler');
  if (!wranglerVersion) {
    gaps.push('package.json: devDependencies.wrangler is missing; new Worker scaffolds need Wrangler installed locally.');
  } else if (!dependencyRangeAllowsWranglerV4(wranglerVersion)) {
    gaps.push(`package.json: devDependencies.wrangler is "${wranglerVersion}", but new Worker scaffolds should use "latest" or a v4+ range.`);
  }

  if (usesTypeScript) {
    const nodeTypesVersion = packageDependencyVersion(packageJson, '@types/node');
    if (!nodeTypesVersion) {
      gaps.push(
        'package.json: devDependencies["@types/node"] is missing; nodejs_compat Worker TypeScript projects need Node.js type declarations for generated Wrangler types.',
      );
    }
  }

  return [
    ...gaps,
    ...frontendFrameworkDependencyGaps(repoPath),
    ...(usesTypeScript ? tsconfigWorkerScaffoldGaps(repoPath) : []),
    ...workerScaffoldGitignoreGaps(repoPath),
  ];
}

function remediationHasVerificationFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(verification_passed|build_verification_passed|npm run|typecheck|tsc|TS\d+|Cannot find module)\b/i.test(item),
  );
}

export type TypeScriptDiagnostic = {
  path: string;
  line: number;
  column: number;
  code: string;
  message: string;
};

export function typeScriptDiagnosticsFromText(text: string) {
  const diagnostics: TypeScriptDiagnostic[] = [];
  const seen = new Set<string>();
  const diagnosticPattern = /(^|\n)([^:\n()]+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+([^\n\r]+)/g;

  for (const match of text.matchAll(diagnosticPattern)) {
    const path = normalizeDeliveryPathReference(match[2] ?? '');
    const line = Number(match[3]);
    const column = Number(match[4]);
    const code = match[5] ?? '';
    const message = (match[6] ?? '').trim();
    if (!path || !Number.isInteger(line) || !Number.isInteger(column) || !code || !message) continue;

    const key = `${path}:${line}:${column}:${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ path, line, column, code, message });
  }

  return diagnostics;
}

export function typeScriptDiagnosticsFromRemediation(remediation: string[]) {
  return typeScriptDiagnosticsFromText(remediation.join('\n'));
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

function remediationHasReadBudgetFailure(remediation: string[]) {
  return remediation.some((item) => /\bREAD_BUDGET_EXCEEDED\b|pre-write read\/list budget/i.test(item));
}

function remediationHasWorkerConfigFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(cloudflare_worker_config_current|worker_config_hygiene|compatibility_date|nodejs_compat|observability)\b/i.test(
      item,
    ),
  );
}

function remediationHasWorkerPackageFailure(remediation: string[]) {
  return remediation.some((item) =>
    /\b(worker_package_scaffold_current|worker_package_hygiene|worker-configuration\.d\.ts|generate-types|generated Wrangler types|wrangler v4|new Worker scaffolds)\b/i.test(
      item,
    ),
  );
}

export function implementationFailureClass(remediation: string[]) {
  if (remediationHasMissingSurfaceFailure(remediation)) return 'missing_surface' as const;
  if (remediationHasUnreplacedPreflightStubFailure(remediation)) return 'preflight_stub' as const;
  if (remediationHasReadBudgetFailure(remediation)) return 'read_budget' as const;
  if (remediationHasWorkerPackageFailure(remediation)) return 'worker_package' as const;
  if (remediationHasWorkerConfigFailure(remediation)) return 'worker_config' as const;
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
  if (
    (timeoutRecovery || noActionRecovery || failureClass === 'missing_surface' || failureClass === 'read_budget') &&
    missingSurfaces.length
  ) {
    return 'write-first' as const;
  }
  if (
    timeoutRecovery ||
    noActionRecovery ||
    failureClass === 'read_budget' ||
    failureClass === 'worker_package' ||
    failureClass === 'worker_config' ||
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
  readBudgetExceeded = false,
  priorRemediation = [],
}: {
  task: Task;
  timeoutMs: number;
  missingSurfaces: string[];
  repairRecovery: boolean;
  noToolCall?: boolean;
  readBudgetExceeded?: boolean;
  priorRemediation?: string[];
}) {
  if (readBudgetExceeded && missingSurfaces.length) {
    return [
      `READ_BUDGET_EXCEEDED ${task.id}: the build attempt exhausted the pre-write read/list budget before creating owned surfaces. Create the missing owned surfaces now without listing or reading more files: ${missingSurfaces.join(', ')}.`,
    ];
  }

  if (readBudgetExceeded) {
    return preservePriorRemediation(
      [
        `READ_BUDGET_EXCEEDED ${task.id}: the build attempt exhausted the pre-write read/list budget. Make a focused write/edit to the boundary surfaces before any more reads.`,
      ],
      priorRemediation,
    );
  }

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
  return packageVerificationScripts(repoPath)[0];
}

function packageVerificationScripts(repoPath: string) {
  const scripts = packageScripts(repoPath);
  return ['typecheck', 'check', 'test', 'build'].filter((script) => typeof scripts[script] === 'string');
}

export function buildVerificationCommandPlan(repoPath: string) {
  const script = buildVerificationScript(repoPath);
  if (script) {
    return {
      command: `npm run ${script}`,
      executable: 'npm',
      args: ['run', script],
      timeoutMs: 120_000,
    };
  }

  const dryRunCommand = releaseGateWorkerDeployDryRunCommand(repoPath);
  if (!dryRunCommand) return undefined;

  return {
    ...dryRunCommand,
    timeoutMs: 180_000,
  };
}

async function ensureNodeDependencies({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<{ command: string; ok: boolean; reason: string; output_summary?: string; error?: string } | undefined> {
  const root = resolve(repoPath);
  const packagePath = join(root, 'package.json');
  const packageLockPath = join(root, 'package-lock.json');
  const nodeModulesPath = join(root, 'node_modules');
  if (!existsSync(packagePath)) return undefined;
  if (existsSync(nodeModulesPath) && existsSync(packageLockPath)) {
    try {
      if (statSync(packageLockPath).mtimeMs >= statSync(packagePath).mtimeMs) return undefined;
    } catch {
      // Fall through to npm install when mtimes cannot be read.
    }
  }

  const command = 'npm install';
  const reason = 'Node dependencies were missing or stale before local validation, so npm install is required evidence.';
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: 180_000 });
  try {
    const result = await execFileAsync('npm', ['install'], {
      cwd: root,
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
    return {
      command,
      ok: true,
      reason,
      output_summary: compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500),
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
    return {
      command,
      ok: false,
      reason,
      error: failure,
    };
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
  const verificationCommand = buildVerificationCommandPlan(repoPath);
  if (!verificationCommand) {
    return {
      performed: [] as string[],
      missing: ['No package verification script or Wrangler config found for this build task.'],
    };
  }

  await ensureNodeDependencies({ repoPath, mastra, stage });

  const command = verificationCommand.command;
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: verificationCommand.timeoutMs });
  try {
    const result = await execFileAsync(verificationCommand.executable, verificationCommand.args, {
      cwd: resolve(repoPath),
      timeout: verificationCommand.timeoutMs,
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

type ReleaseGateJsonExpectation = Record<string, string | number | boolean | null>;

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
  textContains?: string;
  jsonContains?: ReleaseGateJsonExpectation;
  jsonContainsAny?: ReleaseGateJsonExpectation[];
  jsonFieldMatches?: Record<string, string>;
  jsonFieldsEqualVariables?: Record<string, string>;
  jsonArrayAssertions?: ReleaseGateJsonArrayAssertion[];
  headersContain?: Record<string, string>;
  captures?: Record<string, string>;
  body?: ReleaseGateHttpRequestBody;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
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

const releaseGateLocalAdminToken = 'release-gate-local-admin-token';

function firstTomlStringValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text);
  return match?.[1];
}

function releaseGateAdminHeaders(adminToken = releaseGateLocalAdminToken) {
  return { authorization: `Bearer ${adminToken}` };
}

function parseDevVarsValue(text: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = /^["'](.*)["']$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

function releaseGateLocalWorkerEnvironment(repoPath: string) {
  return releaseGateWorkerConfigPath(repoPath) ? 'staging' : undefined;
}

export function releaseGateLocalAdminSecretPath(repoPath: string) {
  const root = resolve(repoPath);
  const environmentName = releaseGateLocalWorkerEnvironment(repoPath);
  const candidates = environmentName
    ? [
        `.dev.vars.${environmentName}`,
        '.dev.vars',
        `.env.${environmentName}.local`,
        '.env.local',
        `.env.${environmentName}`,
        '.env',
      ]
    : ['.dev.vars', '.env.local', '.env'];
  const existing = candidates.find((file) => existsSync(join(root, file)));

  return join(root, existing ?? (environmentName ? `.dev.vars.${environmentName}` : '.dev.vars'));
}

function prepareReleaseGateLocalAdminSecret(repoPath: string) {
  const devVarsPath = releaseGateLocalAdminSecretPath(repoPath);
  if (existsSync(devVarsPath)) {
    const original = readFileSync(devVarsPath, 'utf8');
    const existingToken = parseDevVarsValue(original, 'ADMIN_TOKEN');
    if (existingToken) return { token: existingToken, restore: () => undefined };

    writeFileSync(devVarsPath, `${original.replace(/\s*$/, '\n')}ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
    return {
      token: releaseGateLocalAdminToken,
      restore: () => writeFileSync(devVarsPath, original),
    };
  }

  writeFileSync(devVarsPath, `ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
  return {
    token: releaseGateLocalAdminToken,
    restore: () => {
      if (existsSync(devVarsPath)) unlinkSync(devVarsPath);
    },
  };
}

function releaseGateWorkerConfigPath(repoPath: string) {
  const root = resolve(repoPath);
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].map((file) => join(root, file)).find((path) => existsSync(path));
}

function releaseGateWorkerConfigMain(repoPath: string) {
  const configPath = releaseGateWorkerConfigPath(repoPath);
  if (!configPath) return undefined;

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return firstTomlStringValue(text, 'main');

  const config = parseWranglerJsonConfig(text);
  return typeof config?.main === 'string' ? config.main : undefined;
}

function releaseGateHasTypeScriptWorkerSource(repoPath: string) {
  if (repoUsesTypeScriptWorkerSource(repoPath)) return true;

  const main = releaseGateWorkerConfigMain(repoPath);
  const normalizedMain = typeof main === 'string' ? normalizeDeliveryPathReference(main) : undefined;
  if (!normalizedMain || isAbsolute(normalizedMain) || !workerSourceSurfaceIsTypeScript(normalizedMain)) return false;

  return existsSync(join(resolve(repoPath), normalizedMain));
}

export function releaseGateLocalD1DatabaseName(repoPath: string) {
  const wranglerPath = releaseGateWorkerConfigPath(repoPath);
  if (!wranglerPath) return undefined;

  const environmentName = workerConfigHasEnvironment(repoPath, 'staging') ? 'staging' : undefined;
  const text = readFileSync(wranglerPath, 'utf8');
  if (wranglerPath.endsWith('.toml')) {
    return (
      (environmentName ? workerTomlD1DatabaseName(text, environmentName) : undefined) ??
      workerTomlD1DatabaseName(text)
    );
  }

  const config = parseWranglerJsonConfig(text);
  const environment = environmentName && config ? workerJsonEnvironmentRecord(config, environmentName) : undefined;
  return workerJsonD1DatabaseName(environment) ?? workerJsonD1DatabaseName(config);
}

function d1DatabaseNameFromRecord(record: Record<string, unknown> | undefined) {
  const databaseName = record?.database_name;
  const databaseId = record?.database_id;
  const binding = record?.binding;
  if (typeof databaseName === 'string' && databaseName.trim()) return databaseName;
  if (typeof databaseId === 'string' && databaseId.trim()) return databaseId;
  if (typeof binding === 'string' && binding.trim()) return binding;
  return undefined;
}

function workerJsonD1DatabaseName(config: Record<string, unknown> | undefined) {
  if (!config) return undefined;
  const d1Databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  for (const database of d1Databases) {
    const databaseName = d1DatabaseNameFromRecord(recordValue(database));
    if (databaseName) return databaseName;
  }

  return undefined;
}

function workerTomlD1DatabaseName(text: string, environmentName?: string) {
  const tableName = environmentName ? `env.${environmentName}.d1_databases` : 'd1_databases';
  for (const body of tomlArrayTableBodies(text, tableName)) {
    const databaseName = d1DatabaseNameFromRecord({
      database_name: firstTomlStringValue(body, 'database_name'),
      database_id: firstTomlStringValue(body, 'database_id'),
      binding: firstTomlStringValue(body, 'binding'),
    });
    if (databaseName) return databaseName;
  }

  return undefined;
}

function releaseGateLocalD1Environment(repoPath: string) {
  return releaseGateLocalWorkerEnvironment(repoPath);
}

function sourceTreeContainsText(rootPath: string, needle: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return readFileSync(rootPath, 'utf8').includes(needle);
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

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
  if (
    route === '/health' &&
    ['src/routes/health.ts', 'src/routes/health.js', 'src/routes/health.mjs'].some((path) => existsSync(join(root, path)))
  ) {
    return true;
  }
  if (
    route === '/api/health' &&
    ['src/routes/api/health.ts', 'src/routes/api/health.js', 'src/routes/api/health.mjs'].some((path) =>
      existsSync(join(root, path)),
    )
  ) {
    return true;
  }
  return workerSourceContainsRouteLiteral(repoPath, route);
}

function releaseGateHealthRoutes(repoPath: string) {
  return ['/api/health', '/health'].filter((route) => releaseGateRepoHasRoute(repoPath, route));
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

function releaseGateTableColumns(schema: string, tableName: string) {
  const columns = new Set<string>();
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableMatch = new RegExp(
    `CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${escapedTable}\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    'i',
  ).exec(schema);
  if (!tableMatch) return columns;

  for (const segment of tableMatch[1].split(/,|\r?\n/)) {
    const match = segment.match(/^\s*([A-Za-z_][\w]*)\s+/);
    if (!match) continue;
    const column = match[1].toLowerCase();
    if (['constraint', 'primary', 'foreign', 'unique', 'check'].includes(column)) continue;
    columns.add(column);
  }

  return columns;
}

function releaseGateMissingTableColumns(schema: string, tableName: string, requiredColumns: string[]) {
  const columns = releaseGateTableColumns(schema, tableName);
  if (!columns.size) return [`${tableName} table is missing`];
  return requiredColumns.filter((column) => !columns.has(column));
}

export function releaseGateTranscriptFixtureSchemaGaps(repoPath: string) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  if (!sourcePolicy.talkingHeadTranscriptRequired) return [];
  if (!releaseGateRepoHasRoute(repoPath, '/latest')) return [];

  const schema = releaseGateMigrationText(repoPath);
  if (!schema.trim()) return ['GET /latest route is present but migrations/ contains no SQL schema.'];

  const checks = [
    {
      table: 'runs',
      columns: [
        'id',
        'status',
        'window_start',
        'window_end',
        'audience_profile_id',
        'voice_profile_id',
        'selected_candidate_id',
        'transcript_id',
        'error_message',
        'created_at',
        'updated_at',
      ],
    },
    {
      table: 'candidates',
      columns: [
        'id',
        'run_id',
        'bookmark_id',
        'link_id',
        'source_url',
        'title',
        'author',
        'published_at',
        'summary',
        'core_idea',
        'suggested_angle',
        'primary_segment',
        'segment_fit_json',
        'created_at',
      ],
    },
    {
      table: 'transcripts',
      columns: [
        'id',
        'run_id',
        'candidate_id',
        'audience_profile_id',
        'voice_profile_id',
        'title',
        'hook',
        'transcript',
        'captions_json',
        'source_urls_json',
        'why_this_was_picked',
        'primary_segment',
        'alternate_angles_json',
        'word_count',
        'created_at',
      ],
    },
  ];

  return checks.flatMap(({ table, columns }) =>
    releaseGateMissingTableColumns(schema, table, columns).map((missing) =>
      missing.endsWith('table is missing')
        ? missing
        : `${table}.${missing} is required for seeded GET /latest release-gate validation`,
    ),
  );
}

function releaseGateTranscriptFixtureAvailable(repoPath: string) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  const schema = releaseGateMigrationText(repoPath);
  return (
    sourcePolicy.talkingHeadTranscriptRequired &&
    Boolean(releaseGateLocalD1DatabaseName(repoPath)) &&
    releaseGateRepoHasRoute(repoPath, '/latest') &&
    /\bCREATE\s+TABLE\s+runs\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+candidates\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+transcripts\b/i.test(schema) &&
    releaseGateTranscriptFixtureSchemaGaps(repoPath).length === 0
  );
}

function releaseGateTranscriptFixtureSql() {
  return [
    '-- Release-gate fixture: completed run plus original and regenerated transcript versions.',
    'PRAGMA foreign_keys = OFF;',
    "INSERT OR REPLACE INTO candidates (id, run_id, bookmark_id, link_id, source_url, title, author, published_at, summary, core_idea, suggested_angle, primary_segment, segment_fit_json, created_at) VALUES ('release-gate-candidate', 'release-gate-run', 'release-gate-bookmark', NULL, 'https://example.com/release-gate-source', 'Release Gate Candidate', 'Release Gate', '2026-01-01T00:00:00.000Z', 'Fixture candidate for release-gate transcript persistence.', 'Prove completed transcript persistence through GET /latest.', 'Show that the latest transcript is served from D1.', 'operators', '[{\"segmentName\":\"operators\",\"relevance\":5}]', '2026-01-01T00:00:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v1', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Original Transcript', 'Original hook.', 'Original transcript retained for audit.', '[\"Original caption\"]', '[\"https://example.com/release-gate-source\"]', 'Original selection rationale.', 'operators', '[\"Original alternate angle\"]', 5, '2026-01-01T00:05:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v2', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Regenerated Transcript', 'Regenerated hook.', 'Regenerated transcript served as latest while the original remains stored.', '[\"Regenerated caption\"]', '[\"https://example.com/release-gate-source\"]', 'Regenerated selection rationale.', 'operators', '[\"Regenerated alternate angle\"]', 9, '2026-01-01T00:10:00.000Z');",
    "INSERT OR REPLACE INTO runs (id, status, window_start, window_end, audience_profile_id, voice_profile_id, selected_candidate_id, transcript_id, error_message, created_at, updated_at) VALUES ('release-gate-run', 'completed', '2025-12-25T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'release-gate-audience', 'release-gate-voice', 'release-gate-candidate', 'release-gate-transcript-v2', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z');",
    'PRAGMA foreign_keys = ON;',
    '',
  ].join('\n');
}

function writeReleaseGateTranscriptFixtureFile(repoPath: string) {
  const fixturePath = join(resolve(repoPath), '.delivery', 'tmp', 'release-gate-transcript-fixture.sql');
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, releaseGateTranscriptFixtureSql());
  return '.delivery/tmp/release-gate-transcript-fixture.sql';
}

function localWranglerExecutable(repoPath: string) {
  const executable = join(resolve(repoPath), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  return existsSync(executable) ? executable : undefined;
}

function wranglerProcessCommand(repoPath: string, displayTail: string, args: string[]): ReleaseGateProcessCommand {
  const localWrangler = localWranglerExecutable(repoPath);
  if (localWrangler) {
    return {
      command: `./node_modules/.bin/wrangler ${displayTail}`,
      executable: localWrangler,
      args,
    };
  }

  return {
    command: `npx wrangler ${displayTail}`,
    executable: 'npx',
    args: ['wrangler', ...args],
  };
}

export function releaseGateWorkerDevCommand(
  repoPath: string,
  port: number | '<port>' = '<port>',
  persistTo?: string | '<persist-to>',
) {
  if (!releaseGateWorkerConfigPath(repoPath)) return undefined;

  const portValue = String(port);
  const persistArgs = persistTo ? ['--persist-to', String(persistTo)] : [];
  const persistCommand = persistTo ? ` --persist-to ${String(persistTo)}` : '';
  return wranglerProcessCommand(repoPath, `dev --env staging --ip 127.0.0.1 --port ${portValue}${persistCommand}`, [
    'dev',
    '--env',
    'staging',
    '--ip',
    '127.0.0.1',
    '--port',
    portValue,
    ...persistArgs,
  ]);
}

export function releaseGateWorkerDeployDryRunCommand(repoPath: string) {
  if (!releaseGateWorkerConfigPath(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'deploy --dry-run --env production', [
    'deploy',
    '--dry-run',
    '--env',
    'production',
  ]);
}

export function releaseGateWorkerStartupCheckCommand(repoPath: string) {
  if (!releaseGateWorkerConfigPath(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'check startup --args="--env production"', [
    'check',
    'startup',
    '--args=--env production',
  ]);
}

export function releaseGateWorkerTypesCheckCommand(repoPath: string) {
  if (!releaseGateWorkerConfigPath(repoPath) || !releaseGateHasTypeScriptWorkerSource(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'types --check', ['types', '--check']);
}

function releaseGateStaticAssetTextMarker(repoPath: string, relativePath: string) {
  const assetPath = join(resolve(repoPath), relativePath);
  if (!existsSync(assetPath)) return undefined;
  const text = readFileSync(assetPath, 'utf8').trim();
  return text ? text.slice(0, 120) : undefined;
}

function releaseGatePublicAssetProbe(repoPath: string, file: 'index.html' | 'styles.css' | 'app.js') {
  const route = file === 'index.html' ? '/' : `/${file}`;
  const marker = releaseGateStaticAssetTextMarker(repoPath, `public/${file}`);
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

function releaseGateHasLinkLifecycleRoutes(repoPath: string) {
  return (
    releaseGateRepoHasRoute(repoPath, '/api/links') &&
    releaseGateRepoHasRoute(repoPath, '/api/links/') &&
    releaseGateRepoHasRoute(repoPath, '/l/')
  );
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

export function releaseGateRuntimeProbePlan(
  repoPath: string,
  adminToken = releaseGateLocalAdminToken,
): ReleaseGateRuntimeProbePlan | undefined {
  const command = releaseGateWorkerDevCommand(repoPath);
  if (!command) return undefined;
  const sourceDocuments = sourceDocumentsFromRepo(repoPath);
  const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
  const adminHeaders = releaseGateAdminHeaders(adminToken);
  const indexAssetProbe = releaseGatePublicAssetProbe(repoPath, 'index.html');
  const defaultRootProbe: ReleaseGateHttpProbePlan = {
    method: 'GET',
    path: '/',
    expected: 'Local Worker runtime responds with an HTTP status below 500.',
    statusBelow: 500,
    reason: 'A non-5xx response proves wrangler dev started and can serve local Worker requests.',
  };

  const probes: ReleaseGateHttpProbePlan[] = [indexAssetProbe ?? defaultRootProbe];

  for (const assetProbe of [
    releaseGatePublicAssetProbe(repoPath, 'styles.css'),
    releaseGatePublicAssetProbe(repoPath, 'app.js'),
  ]) {
    if (assetProbe) probes.push(assetProbe);
  }

  for (const healthRoute of releaseGateHealthRoutes(repoPath)) {
    probes.push({
      method: 'GET',
      path: healthRoute,
      expected: `GET ${healthRoute} returns HTTP 200 JSON health status.`,
      expectedStatus: 200,
      jsonContainsAny: [{ status: 'ok' }, { ok: true }],
      reason: `A ${healthRoute} health route was present in the source tree.`,
    });
  }

  if (sourceDocumentsDeclareShortLinkLifecycle(sourceDocuments) && releaseGateHasLinkLifecycleRoutes(repoPath)) {
    probes.push(...releaseGateLinkLifecycleProbes());
  }

  if (sourcePolicy.talkingHeadTranscriptRequired && releaseGateRepoHasRoute(repoPath, '/latest')) {
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

  if (sourcePolicy.talkingHeadTranscriptRequired && releaseGateRepoHasRoute(repoPath, '/runs')) {
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

  if (sourcePolicy.talkingHeadTranscriptRequired && releaseGateRepoHasRoute(repoPath, '/profiles')) {
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
  const typesCheckCommand = releaseGateWorkerTypesCheckCommand(repoPath);
  if (typesCheckCommand) {
    commands.push({
      tier: 'smoke',
      command: typesCheckCommand.command,
      executable: typesCheckCommand.executable,
      args: typesCheckCommand.args,
      required: true,
      reason:
        'TypeScript Worker source and Wrangler config were present, so generated Worker binding types must be current before local validation.',
    });
  }

  for (const script of packageVerificationScripts(repoPath)) {
    commands.push({
      tier: 'smoke',
      command: `npm run ${script}`,
      executable: 'npm',
      args: ['run', script],
      required: true,
      reason: `Project verification script "${script}" was available.`,
    });
  }

  const deployDryRunCommand = releaseGateWorkerDeployDryRunCommand(repoPath);
  if (deployDryRunCommand) {
    commands.push({
      tier: 'api',
      command: deployDryRunCommand.command,
      executable: deployDryRunCommand.executable,
      args: deployDryRunCommand.args,
      required: true,
      reason:
        'A Wrangler Worker config was present, so production deploy bundling must pass a local Wrangler dry-run before approval.',
    });
  }

  const startupCheckCommand = releaseGateWorkerStartupCheckCommand(repoPath);
  if (startupCheckCommand) {
    commands.push({
      tier: 'api',
      command: startupCheckCommand.command,
      executable: startupCheckCommand.executable,
      args: startupCheckCommand.args,
      required: true,
      reason:
        'A Wrangler Worker config was present, so Worker startup must be profiled locally before production approval.',
    });
  }

  const databaseName = releaseGateLocalD1DatabaseName(repoPath);
  if (databaseName && existsSync(join(resolve(repoPath), 'migrations'))) {
    const environmentName = releaseGateLocalD1Environment(repoPath);
    const environmentArgs = environmentName ? ['--env', environmentName] : [];
    const environmentCommand = environmentName ? ` --env ${environmentName}` : '';
    const persistArgs = persistTo ? ['--persist-to', persistTo] : [];
    const persistCommand = persistTo ? ` --persist-to ${persistTo}` : '';
    const migrationCommand = wranglerProcessCommand(
      repoPath,
      `d1 migrations apply ${databaseName}${environmentCommand} --local${persistCommand}`,
      ['d1', 'migrations', 'apply', databaseName, ...environmentArgs, '--local', ...persistArgs],
    );
    commands.push({
      tier: 'api',
      command: migrationCommand.command,
      executable: migrationCommand.executable,
      args: migrationCommand.args,
      required: true,
      reason: 'Wrangler D1 config and migrations/ were present, so local D1 migration validation is required before deployment.',
    });

    if (releaseGateTranscriptFixtureAvailable(repoPath)) {
      const fixturePath = writeReleaseGateTranscriptFixtureFile(repoPath);
      const versionAuditSql =
        "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = 'release-gate-transcript-v1' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = 'release-gate-transcript-v2' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = 'release-gate-run') AS active_transcript_id FROM transcripts WHERE run_id = 'release-gate-run'";
      commands.push(
        {
          tier: 'api',
          ...wranglerProcessCommand(
            repoPath,
            `d1 execute ${databaseName}${environmentCommand} --local${persistCommand} --file ${fixturePath} --json`,
            ['d1', 'execute', databaseName, ...environmentArgs, '--local', ...persistArgs, '--file', fixturePath, '--json'],
          ),
          required: true,
          reason:
            'A latest transcript route and transcript schema were present, so release gate seeds a completed run with original and regenerated transcript versions.',
        },
        {
          tier: 'api',
          ...wranglerProcessCommand(
            repoPath,
            `d1 execute ${databaseName}${environmentCommand} --local${persistCommand} --command "${versionAuditSql}" --json`,
            ['d1', 'execute', databaseName, ...environmentArgs, '--local', ...persistArgs, '--command', versionAuditSql, '--json'],
          ),
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
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  const aiGaps = workersAiBindingGaps(repoPath);
  const workerConfigGaps = workerConfigHygieneGaps(repoPath);
  const workerPackageGaps = workerPackageScaffoldGaps(repoPath);
  const transcriptFixtureGaps = releaseGateTranscriptFixtureSchemaGaps(repoPath);
  const results: ReleaseGateEvidenceResult[] = [];

  if (repoSourceUsesWorkersAi(repoPath) || aiGaps.length) {
    const ok = aiGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Workers AI binding configured',
	      ok,
	      required: true,
	      reason: 'Source uses Workers AI, so the Worker must expose a real AI binding before AI-backed routes or workflows can be accepted.',
	      output_summary: ok
	        ? 'Wrangler config contains active Workers AI binding; TypeScript Env declarations, when present, keep AI required.'
	        : undefined,
	      error: ok ? undefined : aiGaps.join(' '),
	    });
  }

  if (
    sourcePolicy.talkingHeadTranscriptRequired &&
    releaseGateRepoHasRoute(repoPath, '/latest') &&
    releaseGateMigrationText(repoPath).trim()
  ) {
    const ok = transcriptFixtureGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Latest transcript fixture schema',
      ok,
      required: true,
      reason:
        'GET /latest is present, so the local release gate must be able to seed and verify a completed regenerated transcript through D1.',
      output_summary: ok ? 'D1 schema supports seeded latest-transcript release-gate validation.' : undefined,
      error: ok ? undefined : transcriptFixtureGaps.join(' '),
    });
  }

  if (releaseGateWorkerConfigPath(repoPath) || workerConfigGaps.length) {
    const ok = workerConfigGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Worker config hygiene',
      ok,
      required: true,
      reason:
        'Worker release requires a current Wrangler config with local schema validation, recent compatibility date, Node.js compatibility, and observability.',
      output_summary: ok ? 'Wrangler config is current, Node-compatible, and observable.' : undefined,
      error: ok ? undefined : workerConfigGaps.join(' '),
    });
  }

  if (repoLooksLikeWorkerProject(repoPath) || workerPackageGaps.length) {
    const ok = workerPackageGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Worker package scaffold hygiene',
      ok,
      required: true,
      reason:
        'Worker release requires local Wrangler tooling, staging/production package scripts, vanilla frontend dependencies, and gitignored local delivery/Wrangler state.',
      output_summary: ok
        ? 'Worker package scripts and local tooling match the Worker-first release policy.'
        : undefined,
      error: ok ? undefined : workerPackageGaps.join(' '),
    });
  }

  return results;
}

export function releaseGateRequiredStaticEvidenceFailures(results: ReleaseGateEvidenceResult[]) {
  return results.filter((result) => result.required && !result.ok);
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
  expected: ReleaseGateJsonExpectation,
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

function jsonContainsAnyExpected(body: string, expectedOptions: ReleaseGateJsonExpectation[]) {
  const failures = expectedOptions.map((expected) => jsonContainsExpected(body, expected));
  if (failures.some((result) => result.ok)) return { ok: true };

  return {
    ok: false,
    error: `Expected response JSON to match one of ${JSON.stringify(expectedOptions)}. ${
      failures.find((result) => result.error)?.error ?? ''
    }`.trim(),
  };
}

function parseJsonRecordExpected(body: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactDiagnostic(error, 300)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Response JSON was not an object.' };
  }

  return { ok: true, record: parsed as Record<string, unknown> };
}

function jsonFieldMatchesExpected(body: string, expected: Record<string, string>) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  for (const [key, pattern] of Object.entries(expected)) {
    const value = parsed.record[key];
    if (typeof value !== 'string' || !new RegExp(pattern).test(value)) {
      return {
        ok: false,
        error: `Expected JSON field ${key} to match /${pattern}/, received ${JSON.stringify(value)}.`,
      };
    }
  }

  return { ok: true };
}

function jsonFieldsEqualVariablesExpected(
  body: string,
  expected: Record<string, string>,
  variables: Record<string, string>,
) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  for (const [field, variableName] of Object.entries(expected)) {
    const expectedValue = variables[variableName];
    if (expectedValue === undefined) return { ok: false, error: `Probe variable ${variableName} was not captured.` };
    if (parsed.record[field] !== expectedValue) {
      return {
        ok: false,
        error: `Expected JSON field ${field} to equal captured ${variableName}=${JSON.stringify(expectedValue)}, received ${JSON.stringify(parsed.record[field])}.`,
      };
    }
  }

  return { ok: true };
}

function jsonCapturesExpected(body: string, captures: Record<string, string>) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  const values: Record<string, string> = {};
  for (const [variableName, field] of Object.entries(captures)) {
    const value = parsed.record[field];
    if (value === undefined || value === null) {
      return { ok: false, error: `Expected response JSON field ${field} to capture ${variableName}.` };
    }
    values[variableName] = String(value);
  }

  return { ok: true, values };
}

function headersContainExpected(headers: Headers, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = headers.get(key);
    if (!actual || !actual.includes(value)) {
      return { ok: false, error: `Expected response header ${key} to include ${JSON.stringify(value)}, received ${JSON.stringify(actual)}.` };
    }
  }

  return { ok: true };
}

function textContainsExpected(body: string, expected: string) {
  if (body.includes(expected)) return { ok: true };
  return { ok: false, error: `Expected response body to include ${JSON.stringify(expected)}.` };
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
    redirect: probe.redirect,
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

function renderProbeTemplate(template: string, variables: Record<string, string>) {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, variableName: string) => {
    const value = variables[variableName];
    if (value === undefined) {
      missing.add(variableName);
      return '';
    }
    return encodeURIComponent(value);
  });

  if (missing.size) return { ok: false as const, error: `Missing captured probe variable(s): ${Array.from(missing).join(', ')}` };
  return { ok: true as const, value: rendered };
}

async function runHttpProbe(
  baseUrl: string,
  probe: ReleaseGateHttpProbePlan,
  variables: Record<string, string> = {},
): Promise<ReleaseGateHttpProbeResult> {
  const renderedPath = renderProbeTemplate(probe.path, variables);
  if (!renderedPath.ok) {
    return {
      method: probe.method,
      path: probe.path,
      url: new URL('/', baseUrl).toString(),
      expected: probe.expected,
      ok: false,
      error: renderedPath.error,
    };
  }

  const url = new URL(renderedPath.value, baseUrl).toString();
  try {
    const response = await fetch(url, requestInitForProbe(probe));
    const body = await response.text();
    const statusOk = probeStatusMatches(probe, response.status);
    const textCheck = probe.textContains ? textContainsExpected(body, probe.textContains) : { ok: true };
    const jsonCheck = probe.jsonContains ? jsonContainsExpected(body, probe.jsonContains) : { ok: true };
    const jsonAnyCheck = probe.jsonContainsAny ? jsonContainsAnyExpected(body, probe.jsonContainsAny) : { ok: true };
    const jsonFieldCheck = probe.jsonFieldMatches ? jsonFieldMatchesExpected(body, probe.jsonFieldMatches) : { ok: true };
    const jsonVariableCheck = probe.jsonFieldsEqualVariables
      ? jsonFieldsEqualVariablesExpected(body, probe.jsonFieldsEqualVariables, variables)
      : { ok: true };
    const jsonArrayCheck = probe.jsonArrayAssertions
      ? jsonArrayAssertionsExpected(body, probe.jsonArrayAssertions)
      : { ok: true };
    const headerCheck = probe.headersContain ? headersContainExpected(response.headers, probe.headersContain) : { ok: true };
    const captureCheck = probe.captures ? jsonCapturesExpected(body, probe.captures) : { ok: true, values: {} };
    const ok =
      statusOk &&
      textCheck.ok &&
      jsonCheck.ok &&
      jsonAnyCheck.ok &&
      jsonFieldCheck.ok &&
      jsonVariableCheck.ok &&
      jsonArrayCheck.ok &&
      headerCheck.ok &&
      captureCheck.ok;
    if (ok && captureCheck.ok) Object.assign(variables, captureCheck.values);
    const summary = [
      `HTTP ${response.status}`,
      response.headers.get('content-type') ? `content-type ${response.headers.get('content-type')}` : undefined,
      probe.headersContain
        ? Object.keys(probe.headersContain)
            .map((header) => `${header} ${response.headers.get(header) ?? ''}`.trim())
            .join('; ')
        : undefined,
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
        : textCheck.error ??
          jsonCheck.error ??
          jsonAnyCheck.error ??
          jsonFieldCheck.error ??
          jsonVariableCheck.error ??
          jsonArrayCheck.error ??
          headerCheck.error ??
          captureCheck.error ??
          `Expected ${probe.expected}, received HTTP ${response.status}.`,
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
  const initialPlan = releaseGateRuntimeProbePlan(repoPath);
  if (!initialPlan) return undefined;

  const adminSecret = releaseGateRuntimeProbePlanRequiresAdminSecret(initialPlan)
    ? prepareReleaseGateLocalAdminSecret(repoPath)
    : undefined;
  const plan = adminSecret ? releaseGateRuntimeProbePlan(repoPath, adminSecret.token) : initialPlan;
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
      ...(adminSecret ? { ADMIN_TOKEN: adminSecret.token } : {}),
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
      const probeVariables: Record<string, string> = {};
      for (const probe of plan.probes) {
        probes.push(await runHttpProbe(baseUrl, probe, probeVariables));
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
    adminSecret?.restore();
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
  const dependencyInstall = await ensureNodeDependencies({ repoPath, mastra, stage });

  const runtimePlan = releaseGateRuntimeProbePlan(repoPath);
  const runtimePersistTo = runtimePlan ? createReleaseGateRuntimeStatePath(repoPath) : undefined;
  const plan = releaseGateEvidenceCommandPlan(repoPath, runtimePersistTo);
  const staticResults = releaseGateStaticEvidenceResults(repoPath);
  const requiredStaticFailures = releaseGateRequiredStaticEvidenceFailures(staticResults);
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
  if (requiredStaticFailures.length) {
    notes.push(
      `Skipped dynamic Worker API evidence because required static release-gate checks failed: ${requiredStaticFailures
        .map((result) => result.command)
        .join(', ')}.`,
    );
  }
  notes.push('No browser E2E harness is started by this workflow; E2E and full_matrix tiers should be not_required unless cited evidence exists.');

  const commands: ReleaseGateEvidenceResult[] = [];
  if (dependencyInstall) {
    commands.push({
      tier: 'smoke',
      command: dependencyInstall.command,
      ok: dependencyInstall.ok,
      required: true,
      reason: dependencyInstall.reason,
      output_summary: dependencyInstall.output_summary,
      error: dependencyInstall.error,
    });
  }
  const dynamicPlan = plan.filter((command) => command.tier !== 'smoke');
  for (const command of plan.filter((item) => item.tier === 'smoke')) {
    commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
  }
  for (const result of staticResults) {
    await recordReleaseGateStaticEvidenceResult({ repoPath, mastra, stage, result });
    commands.push(result);
  }
  if (!requiredStaticFailures.length) {
    for (const command of dynamicPlan) {
      commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
    }
    const runtimeResult = await runReleaseGateRuntimeProbe({ repoPath, mastra, stage, persistTo: runtimePersistTo });
    if (runtimeResult) commands.push(runtimeResult);
  }

  return {
    artifact_type: 'test-evidence',
    stage,
    commands,
    notes,
  };
}

const acceptanceCriterionStopWords = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'using',
  'uses',
  'use',
  'when',
  'then',
  'than',
  'only',
  'each',
  'every',
  'after',
  'before',
  'through',
  'without',
  'within',
  'must',
  'should',
  'can',
  'will',
  'does',
  'not',
  'are',
  'is',
  'be',
  'by',
  'or',
  'as',
  'to',
  'in',
  'on',
  'of',
  'a',
  'an',
]);

function normalizeAcceptanceEvidenceText(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9/_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function acceptanceCriterionTokens(criterion: string) {
  return Array.from(
    new Set(
      normalizeAcceptanceEvidenceText(criterion)
        .split(/\s+/)
        .map((token) => token.replace(/^["'`]+|["'`,.;:]+$/g, ''))
        .filter((token) => token.length >= 3)
        .filter((token) => !acceptanceCriterionStopWords.has(token))
        .filter((token) => !/^\d+$/.test(token)),
    ),
  );
}

function acceptanceEvidenceFiles(repoPath?: string, task?: Task) {
  if (!repoPath || !task) return [];
  return repoFileContents(repoPath, taskBoundarySurfaces(repoPath, task));
}

function acceptanceCriterionCommandEvidence(criterion: string, performed: string[]) {
  const text = criterion.toLowerCase();
  const evidence = performed.join('\n').toLowerCase();

  if (/\b(typecheck|tsc|typescript)\b/.test(text) && /\b(typecheck|tsc)\b/.test(evidence)) {
    return 'verification command covered TypeScript/typecheck criterion';
  }
  if (/\btest(s|ing)?\b/.test(text) && /\btest\b/.test(evidence)) {
    return 'verification command covered test criterion';
  }
  if (/\bbuild\b/.test(text) && /\bbuild\b/.test(evidence)) {
    return 'verification command covered build criterion';
  }
  if (/\bwrangler dev\b/.test(text) && /\bwrangler dev\b/.test(evidence)) {
    return 'verification command covered wrangler dev criterion';
  }
  if (/\bhealth\b|\/health\b|http 200|status 200/.test(text) && /\bhealth\b|\/health\b|http 200|status 200/.test(evidence)) {
    return 'verification command covered HTTP health/status criterion';
  }

  return undefined;
}

function acceptanceCriterionFileEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  const files = acceptanceEvidenceFiles(repoPath, task);
  if (!files.length) return undefined;

  const references = acceptanceContractReferences(criterion);
  const referencedFiles = references.length
    ? files.filter((file) => references.some((reference) => file.path === reference || file.path.endsWith(reference)))
    : files;
  if (references.length && !referencedFiles.length) return undefined;

  const corpus = normalizeAcceptanceEvidenceText(
    referencedFiles.map((file) => `${file.path}\n${file.content}`).join('\n'),
  );
  const tokens = acceptanceCriterionTokens(criterion);
  if (!tokens.length) return undefined;

  const matched = tokens.filter((token) => corpus.includes(token));
  const required = tokens.length <= 6 ? Math.max(2, tokens.length - 1) : Math.ceil(tokens.length * 0.58);
  if (matched.length < required) return undefined;

  return `file evidence covered ${matched.length}/${tokens.length} acceptance tokens in ${referencedFiles
    .map((file) => file.path)
    .slice(0, 4)
    .join(', ')}`;
}

function workerConfigEnvironmentContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bwrangler\.jsonc\b/i.test(criterion)) return undefined;
  if (!/\benv\.staging\b/i.test(criterion) || !/\benv\.production\b/i.test(criterion)) return undefined;

  const configPath = join(resolve(repoPath), 'wrangler.jsonc');
  if (!taskBoundarySurfaces(repoPath, task).includes('wrangler.jsonc') || !existsSync(configPath)) return undefined;

  const config = parseWranglerJsonConfig(readFileSync(configPath, 'utf8'));
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so environment bindings could not be verified.'],
    };
  }

  const requiredBindingCandidates: Array<{ name: string; kind: WorkerBindingKind }> = [
    { name: 'BOOKMARKS', kind: 'service' },
    { name: 'DB', kind: 'd1' },
    { name: 'ARTIFACTS', kind: 'r2' },
    { name: 'WEEKLY_WORKFLOW', kind: 'workflow' },
    { name: 'AI', kind: 'ai' },
    { name: 'ASSETS', kind: 'assets' },
  ];
  const requiredBindings = requiredBindingCandidates.filter((binding) =>
    new RegExp(`\\b${binding.name}\\b`, 'i').test(criterion),
  );

  const gaps: string[] = [];
  const envVarSets: string[][] = [];
  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (!environment) {
      gaps.push(`wrangler.jsonc env.${environmentName} is missing.`);
      continue;
    }

    const bindings = new Set(
      workerJsonConfigBindingDeclarations(environment).map((binding) => `${binding.kind}:${binding.name}`),
    );
    for (const binding of requiredBindings) {
      if (!bindings.has(`${binding.kind}:${binding.name}`)) {
        gaps.push(`wrangler.jsonc env.${environmentName} is missing ${binding.name} as a ${binding.kind} binding.`);
      }
    }

    if (/assets\.directory\s+["']?\.\/public/i.test(criterion)) {
      const assets = recordValue(environment.assets);
      if (!assetDirectoryIsPublic(assets?.directory)) {
        gaps.push(`wrangler.jsonc env.${environmentName}.assets.directory must be "./public".`);
      }
    }

    if (/assets\.binding\s+["']?ASSETS/i.test(criterion)) {
      const assets = recordValue(environment.assets);
      if (assets?.binding !== 'ASSETS') {
        gaps.push(`wrangler.jsonc env.${environmentName}.assets.binding must be "ASSETS".`);
      }
    }

    const vars = workerJsonConfigVarNames(environment).sort();
    envVarSets.push(vars);
    if (/\bvars\b|\bnon-secret vars\b/i.test(criterion) && vars.length === 0) {
      gaps.push(`wrangler.jsonc env.${environmentName}.vars must declare required non-secret vars.`);
    }
  }

  if (/\bmirrors?\b/i.test(criterion) && envVarSets.length === workerDeploymentEnvironments.length) {
    const [first, ...rest] = envVarSets.map((vars) => vars.join('\n'));
    for (const vars of rest) {
      if (vars !== first) {
        gaps.push('wrangler.jsonc env.staging.vars and env.production.vars must mirror the same non-secret var names.');
        break;
      }
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [
      `structured wrangler.jsonc evidence verified ${workerDeploymentEnvironments.join(
        '/',
      )} environments with ${requiredBindings.map((binding) => `${binding.kind}:${binding.name}`).join(', ')}`,
    ],
    gaps: [],
  };
}

function gitignoreRuntimeArtifactContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\.gitignore\b/i.test(criterion)) return undefined;
  if (!/\b(dependencies|wrangler|env files?|build|runtime artifacts?)\b/i.test(criterion)) return undefined;
  if (!taskBoundarySurfaces(repoPath, task).includes('.gitignore')) return undefined;

  const gitignorePath = join(resolve(repoPath), '.gitignore');
  if (!existsSync(gitignorePath)) return undefined;

  const source = readFileSync(gitignorePath, 'utf8');
  const gaps: string[] = [];
  const requiredGroups: Array<{ label: string; patterns: RegExp[] }> = [
    { label: 'dependencies', patterns: [/^node_modules\/?$/m] },
    { label: 'Wrangler local state', patterns: [/^\.wrangler\/?$/m] },
    { label: 'env files', patterns: [/^\.env\*?$/m, /^\.dev\.vars\*?$/m] },
    { label: 'build/runtime artifacts', patterns: [/^dist\/?$/m, /^build\/?$/m, /^\*\.log$/m] },
  ];

  for (const group of requiredGroups) {
    if (!group.patterns.every((pattern) => pattern.test(source))) {
      gaps.push(`.gitignore must exclude ${group.label}.`);
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured .gitignore evidence verified dependencies, Wrangler state, env files, and build/runtime artifacts'],
    gaps: [],
  };
}

function configScopeHasAdminTokenVar(scope: Record<string, unknown> | undefined) {
  const vars = recordValue(scope?.vars);
  return Boolean(vars && Object.prototype.hasOwnProperty.call(vars, 'ADMIN_TOKEN'));
}

function workerConfigAdminTokenSecretContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bwrangler\.jsonc\b/i.test(criterion) || !/\bADMIN_TOKEN\b/.test(criterion)) return undefined;
  if (!/\b(secret|commit|embed|var)\b/i.test(criterion)) return undefined;
  if (!taskBoundarySurfaces(repoPath, task).includes('wrangler.jsonc')) return undefined;

  const configPath = join(resolve(repoPath), 'wrangler.jsonc');
  if (!existsSync(configPath)) return undefined;

  const source = readFileSync(configPath, 'utf8');
  const config = parseWranglerJsonConfig(source);
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so ADMIN_TOKEN secret readiness could not be verified.'],
    };
  }

  const gaps: string[] = [];
  if (configScopeHasAdminTokenVar(config)) {
    gaps.push('wrangler.jsonc top-level vars must not commit ADMIN_TOKEN.');
  }

  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (configScopeHasAdminTokenVar(environment)) {
      gaps.push(`wrangler.jsonc env.${environmentName}.vars must not commit ADMIN_TOKEN.`);
    }
  }

  if (!/(wrangler\s+secret\s+put\s+ADMIN_TOKEN|ADMIN_TOKEN[\s\S]{0,120}secret|secret[\s\S]{0,120}ADMIN_TOKEN)/i.test(source)) {
    gaps.push('wrangler.jsonc should document ADMIN_TOKEN as a Cloudflare secret, not a committed var.');
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified ADMIN_TOKEN is documented as a secret and not committed in vars'],
    gaps: [],
  };
}

function workerScaffoldProtectedApiContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bscaffold\b/i.test(criterion) || !/\bprotected endpoints?\b/i.test(criterion)) return undefined;
  if (!/\bauth\.js\b/i.test(criterion) || !/\bfail closed\b/i.test(criterion)) return undefined;

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  if (!/(api_not_ready|protected API endpoints? are intentionally unavailable|status:\s*50[13]|501)/i.test(source)) {
    gaps.push(`${indexPath} must keep protected API endpoints unavailable in the scaffold.`);
  }
  if (!/ADMIN_TOKEN[\s\S]{0,240}(secret|missing|invalid|fail closed)|fail closed[\s\S]{0,240}ADMIN_TOKEN/i.test(source)) {
    gaps.push(`${indexPath} must carry forward the later ADMIN_TOKEN fail-closed requirement.`);
  }
  if (!/\bauth\.js\b/i.test(source)) {
    gaps.push(`${indexPath} must point protected API readiness to the later auth.js task.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured scaffold evidence verified protected APIs stay unavailable until auth.js in ${indexPath}`],
    gaps: [],
  };
}

function workerEntrypointExportContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: Task;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bsrc\/index\.(js|ts)\b/i.test(criterion)) return undefined;
  if (!/\bdefault\b/i.test(criterion) || !/\bfetch\b/i.test(criterion) || !/\bWeeklyWorkflow\b/i.test(criterion)) {
    return undefined;
  }

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  if (!/export\s+default\s+\{[\s\S]*\bfetch\s*\(/m.test(source)) {
    gaps.push(`${indexPath} must export a default Worker object with a fetch handler.`);
  }
  if (!/\bexport\s+class\s+WeeklyWorkflow\b/.test(source)) {
    gaps.push(`${indexPath} must export a WeeklyWorkflow class stub.`);
  }
  if (/\bextends\s+WorkflowEntrypoint\b/.test(source) && !/from\s+['"]cloudflare:workers['"]/.test(source)) {
    gaps.push(`${indexPath} extends WorkflowEntrypoint but does not import it from cloudflare:workers.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured Worker entrypoint evidence verified default fetch handler and WeeklyWorkflow export in ${indexPath}`],
    gaps: [],
  };
}

function acceptanceCriterionEvidence({
  criterion,
  performed,
  repoPath,
  task,
}: {
  criterion: string;
  performed: string[];
  repoPath?: string;
  task?: Task;
}) {
  const commandEvidence = acceptanceCriterionCommandEvidence(criterion, performed);
  if (commandEvidence) return { passed: true, evidence: [commandEvidence], gaps: [] };

  const gitignoreEvidence = gitignoreRuntimeArtifactContractEvidence({ criterion, repoPath, task });
  if (gitignoreEvidence) return gitignoreEvidence;

  const adminTokenEvidence = workerConfigAdminTokenSecretContractEvidence({ criterion, repoPath, task });
  if (adminTokenEvidence) return adminTokenEvidence;

  const structuredFileEvidence = workerConfigEnvironmentContractEvidence({ criterion, repoPath, task });
  if (structuredFileEvidence) return structuredFileEvidence;

  const scaffoldProtectedApiEvidence = workerScaffoldProtectedApiContractEvidence({ criterion, repoPath, task });
  if (scaffoldProtectedApiEvidence) return scaffoldProtectedApiEvidence;

  const workerEntrypointEvidence = workerEntrypointExportContractEvidence({ criterion, repoPath, task });
  if (workerEntrypointEvidence) return workerEntrypointEvidence;

  const fileEvidence = acceptanceCriterionFileEvidence({ criterion, repoPath, task });
  if (fileEvidence) return { passed: true, evidence: [fileEvidence], gaps: [] };

  return {
    passed: false,
    evidence: [],
    gaps: [`Acceptance criterion not verified by automated checks or task-boundary file evidence: ${criterion}`],
  };
}

function acceptanceCriterionCovered(
  criterion: string,
  performed: string[],
  options: { repoPath?: string; task?: Task } = {},
) {
  return acceptanceCriterionEvidence({ criterion, performed, ...options }).passed;
}

export function acceptanceContractsForTask({
  repoPath,
  task,
  verification,
}: {
  repoPath?: string;
  task: Task;
  verification: { performed: string[]; missing: string[] };
}) {
  return taskAcceptanceContractCriteria(task).map((criterion, index) => {
    const result = acceptanceCriterionEvidence({
      criterion,
      performed: verification.performed,
      repoPath,
      task,
    });
    return {
      id: acceptanceContractId(task, index),
      criterion,
      status: result.passed ? ('verified' as const) : ('unverified' as const),
      evidence: result.evidence,
      gaps: result.gaps,
    };
  });
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
    if (!acceptanceCriterionCovered(criterion, verification.performed, { repoPath, task })) {
      missing.add(`Acceptance criterion not verified by automated checks: ${criterion}`);
    }
  }

  return {
    performed: verification.performed,
    missing: [...missing],
  };
}

function taskBoundaryAllowsRepairPath(repoPath: string, task: Task, path: string) {
  return matchesAny(path, taskBoundarySurfaces(repoPath, task));
}

function repairUnknownNumberIntegerLine(line: string) {
  return line.replace(/\bNumber\.isInteger\(([_$A-Za-z][_$A-Za-z0-9]*)\)\s*&&/g, (match, identifier, offset) => {
    const prefix = line.slice(0, offset);
    const narrowingPattern = new RegExp(`typeof\\s+${identifier}\\s*===\\s*["']number["']`);
    if (narrowingPattern.test(prefix)) return match;
    return `typeof ${identifier} === "number" && ${match}`;
  });
}

export async function repairUnknownNumberIntegerNarrowing({
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
  const currentTask = topoOrderTasks(taskPlan.tasks)[currentTaskIndex];
  if (!currentTask) return false;

  const diagnostics = typeScriptDiagnosticsFromText(failure).filter(
    (diagnostic) => diagnostic.code === 'TS18046' && /\bunknown\b/i.test(diagnostic.message),
  );
  if (!diagnostics.length) return false;

  const repairedPaths: string[] = [];
  for (const path of new Set(diagnostics.map((diagnostic) => diagnostic.path))) {
    if (!taskBoundaryAllowsRepairPath(repoPath, currentTask, path)) continue;
    const fullPath = join(resolve(repoPath), path);
    if (!existsSync(fullPath)) continue;

    const source = readFileSync(fullPath, 'utf8');
    const next = source
      .split('\n')
      .map((line) => repairUnknownNumberIntegerLine(line))
      .join('\n');
    if (next === source) continue;

    writeFileSync(fullPath, next);
    repairedPaths.push(path);
  }

  if (!repairedPaths.length) return false;

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'tool_use',
      tool: 'auto_repair',
      ok: true,
      stage,
      paths: repairedPaths,
      output_summary:
        'Added typeof number narrowing before Number.isInteger checks after TS18046 unknown-value typecheck failures.',
    },
  }).catch(() => undefined);
  return true;
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

  if (
    taskPlan &&
    typeof taskIndex === 'number' &&
    (await repairUnknownNumberIntegerNarrowing({
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
  const acceptanceContracts = acceptanceContractsForTask({ repoPath, task, verification: honestVerification });

  return {
    artifact_type: 'implementation-note',
    task: task.id,
    changes: [
      `Implemented ${task.id}: ${task.deliverable}`,
      ...(summary ? [`Engineer response: ${compactDiagnostic(summary, 500)}`] : []),
    ],
    files_touched: filesTouched,
    acceptance_contracts: acceptanceContracts,
    assumptions: taskPlan.open_decisions,
    verification: honestVerification,
    risks: taskPlan.risks,
  };
}

function acceptanceContractGaps(note: ImplementationNote) {
  const contractGaps = (note.acceptance_contracts ?? [])
    .filter((contract) => contract.status !== 'verified')
    .map((contract) => `${contract.id}: ${contract.criterion}${contract.gaps.length ? ` (${contract.gaps.join('; ')})` : ''}`);
  if (contractGaps.length) return contractGaps;

  return note.verification.missing
    .filter((item) => /^Acceptance criterion not verified by automated checks:/i.test(item))
    .map((item) => item.replace(/^Acceptance criterion not verified by automated checks:\s*/i, ''));
}

export function implementationDeterministicResults({
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
  const workflowEntrypointGaps = workflowEntrypointImportGaps(repoPath, task);
  const routeMiddlewareGaps = routeMiddlewareBypassGaps(repoPath, task);
  const aiBindingGaps = workersAiBindingGaps(repoPath, task);
  const workerConfigGaps = workerConfigHygieneGaps(repoPath, task);
  const workerPackageGaps = workerPackageScaffoldGaps(repoPath, task);
  const lifecycleStatusGaps = lifecycleStatusSchemaGaps(repoPath, task);
  const profileKindGaps = profileKindContractGaps(repoPath, task);
  const acceptanceGaps = acceptanceContractGaps(note);
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
      id: 'workflow_entrypoint_imported',
      check: 'workflow_entrypoint_imported',
      passed: workflowEntrypointGaps.length === 0,
      reason: workflowEntrypointGaps.length ? workflowEntrypointGaps.join('; ') : 'ok',
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
      id: 'cloudflare_worker_config_current',
      check: 'worker_config_hygiene',
      passed: workerConfigGaps.length === 0,
      reason: workerConfigGaps.length ? workerConfigGaps.join('; ') : 'ok',
    },
    {
      id: 'worker_package_scaffold_current',
      check: 'worker_package_hygiene',
      passed: workerPackageGaps.length === 0,
      reason: workerPackageGaps.length ? workerPackageGaps.join('; ') : 'ok',
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
    {
      id: 'acceptance_contracts_satisfied',
      check: 'acceptance_criteria_contracts',
      passed: acceptanceGaps.length === 0,
      reason: acceptanceGaps.length ? acceptanceGaps.slice(0, 8).join('; ') : 'ok',
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
        'workflow_entrypoint_imported',
        'route_middleware_layering',
        'middleware_layering',
        'workers_ai_binding_required',
        'cloudflare_worker_config_current',
        'worker_config_hygiene',
        'worker_package_scaffold_current',
        'worker_package_hygiene',
        'lifecycle_status_schema_constrained',
        'state_explicitness',
        'profile_kind_contract_aligned',
        'profile_kind_contract',
        'acceptance_contracts_satisfied',
        'acceptance_criteria_contracts',
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

export function releaseGateRequiredEvidencePassed(evidence?: ReleaseGateEvidence): DeterministicGateResult {
  if (!evidence) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: 'release gate evidence artifact was not available',
    };
  }

  const required = evidence.commands.filter((command) => command.required);
  const failed = required.filter((command) => !command.ok);
  if (failed.length) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: `required release-gate evidence failed: ${failed
        .map((command) => `${command.command}: ${command.error ?? 'failed'}`)
        .join('; ')}`,
    };
  }

  return {
    id: 'required_evidence_passed',
    check: 'required_evidence_passed',
    passed: true,
    reason: required.length
      ? `all required release-gate evidence passed: ${required.map((command) => command.command).join(', ')}`
      : 'no required release-gate evidence commands were planned',
  };
}

function releaseGateDeterministicResults({
  stage,
  gate,
  events,
  evidence,
}: {
  stage: string;
  gate: ReleaseGate;
  events: DeliveryEvent[];
  evidence?: ReleaseGateEvidence;
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
    releaseGateRequiredEvidencePassed(evidence),
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

function latestReleaseGateEvidencePath(artifacts: string[]) {
  const path = latestArtifactPath(artifacts, 'test-evidence', '');
  return path || undefined;
}

function readReleaseGateEvidenceArtifact(repoPath: string, artifacts: string[]) {
  const evidencePath = latestReleaseGateEvidencePath(artifacts);
  if (!evidencePath) return undefined;

  const evidence = readJsonArtifact(repoPath, evidencePath);
  if (!evidence || typeof evidence !== 'object') return undefined;
  if ((evidence as { artifact_type?: unknown }).artifact_type !== 'test-evidence') return undefined;
  return evidence as ReleaseGateEvidence;
}

function releaseGateEvidenceVerification(evidence?: ReleaseGateEvidence) {
  const commandRows =
    evidence?.commands.map((command) => ({
      check: command.command,
      expected: command.reason,
      actual: command.ok ? (command.output_summary ?? 'passed') : (command.error ?? 'failed'),
      passed: command.ok,
    })) ?? [];
  const probeRows =
    evidence?.commands.flatMap((command) =>
      (command.probes ?? []).map((probe) => ({
        check: `${probe.method} ${probe.path}`,
        expected: probe.expected,
        actual: probe.ok ? (probe.response_summary ?? 'passed') : (probe.error ?? 'failed'),
        passed: probe.ok,
      })),
    ) ?? [];

  return [...commandRows, ...probeRows];
}

function releaseGateEvidenceIssues(evidence?: ReleaseGateEvidence): DeploymentReport['issues'] {
  const issues: DeploymentReport['issues'] = [];
  for (const command of evidence?.commands ?? []) {
    if (!command.ok) {
      issues.push({
        description: `Release-gate evidence command failed: ${command.command}`,
        impact: command.required
          ? 'Required local validation evidence is missing.'
          : 'Optional local validation evidence is unavailable.',
        action: command.required
          ? 'Fix the failed evidence command before production approval.'
          : 'Review whether this optional evidence should become required.',
      });
    }
    for (const probe of command.probes ?? []) {
      if (!probe.ok) {
        issues.push({
          description: `Local Worker probe failed: ${probe.method} ${probe.path}`,
          impact: probe.expected,
          action: probe.error ?? 'Fix the route or probe expectation before production approval.',
        });
      }
    }
  }
  return issues;
}

export function localDeploymentReportFromReleaseGateEvidence({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
}): DeploymentReport {
  const verification = releaseGateEvidenceVerification(evidence);
  const issues = releaseGateEvidenceIssues(evidence);
  const migrationCommands =
    evidence?.commands
      .filter((command) => command.ok && /\bwrangler\s+d1\s+migrations\s+apply\b/.test(command.command))
      .map((command) => command.command) ?? [];
  const hasRequiredIssue = issues.some((issue) => /Required/.test(issue.impact));
  const releaseGatePassed = releaseGate.decision === 'pass' && releaseGate.blockers.length === 0;
  const result = releaseGatePassed && !hasRequiredIssue ? 'success' : 'failure';

  return {
    artifact_type: 'deployment-report',
    environment: 'local',
    revision: `local:${runId}`,
    migrations_applied: migrationCommands,
    config_changes: [
      'Production deployment not executed; local report synthesized from passing release-gate evidence.',
      'GitHub Actions not used as the deployment path.',
      `Release gate: ${releaseGatePath}`,
      ...(evidencePath ? [`Evidence: ${evidencePath}`] : []),
    ],
    result,
    verification: verification.length
      ? verification
      : [
          {
            check: 'release gate',
            expected: 'Passing pre-deployment release gate with zero blockers.',
            actual: releaseGate.summary,
            passed: releaseGatePassed,
          },
        ],
    issues,
    next_action: result === 'success' ? 'proceed' : 'fix',
    rollback: {
      prior_revision: 'none (local validation only)',
      steps: 'No production rollback is required because no Wrangler production deploy command ran.',
      data_caveats: 'Local Wrangler/D1/R2 state is validation-only and may live under .delivery/tmp.',
    },
  };
}

export function productionWranglerDeployCommand(repoPath: string): ReleaseGateProcessCommand {
  return wranglerProcessCommand(repoPath, 'deploy --env production', ['deploy', '--env', 'production']);
}

function wranglerDeployUrls(output: string) {
  return Array.from(new Set(output.match(/https:\/\/[^\s"'<>]+/g) ?? [])).map((url) => url.replace(/[),.;]+$/, ''));
}

function wranglerDeployRevision(output: string, runId: string) {
  const version = /\b(?:Version ID|Version|version)\s*[:=]\s*([A-Za-z0-9_-]{8,})\b/.exec(output)?.[1];
  return version ? `wrangler:${version}` : `production:${runId}`;
}

async function productionLiveVerification(urls: string[]): Promise<DeploymentReport['verification'][number]> {
  const url = urls[0];
  if (!url) {
    return {
      check: 'production live URL',
      expected: 'Wrangler deploy completes and emits a live URL when available.',
      actual: 'Wrangler deploy completed; no live URL was parsed from output.',
      passed: true,
    };
  }

  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    const body = compactDiagnostic(await response.text(), 300);
    return {
      check: `GET ${url}`,
      expected: 'Production Worker responds with an HTTP status below 500.',
      actual: `HTTP ${response.status}${body ? `; body ${body}` : ''}`,
      passed: response.status < 500,
    };
  } catch (error) {
    return {
      check: `GET ${url}`,
      expected: 'Production Worker responds with an HTTP status below 500.',
      actual: compactDiagnostic(error, 500),
      passed: false,
    };
  }
}

export function productionDeploymentReportFromWranglerResult({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
  deployCommand,
  deployOk,
  deployOutput,
  deployError,
  liveVerification,
  revision,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
  deployCommand: string;
  deployOk: boolean;
  deployOutput?: string;
  deployError?: string;
  liveVerification: DeploymentReport['verification'][number];
  revision?: string;
}): DeploymentReport {
  const evidenceVerification = releaseGateEvidenceVerification(evidence);
  const issues = releaseGateEvidenceIssues(evidence);
  const releaseGatePassed = releaseGate.decision === 'pass' && releaseGate.blockers.length === 0;
  const liveOk = liveVerification.passed !== false;

  if (!deployOk) {
    issues.push({
      description: `Wrangler production deploy failed: ${deployCommand}`,
      impact: 'Production was not updated.',
      action: 'Fix the deploy failure, rerun local release validation, then request production approval again.',
    });
  } else if (!liveOk) {
    issues.push({
      description: 'Production live verification failed after Wrangler deploy.',
      impact: 'The deployed Worker may be serving errors in production.',
      action: 'Inspect Wrangler deployment logs and rollback if the failure affects users.',
    });
  }

  const hasRequiredIssue = issues.some((issue) => /Required/.test(issue.impact));
  const result = releaseGatePassed && deployOk && liveOk && !hasRequiredIssue ? 'success' : 'failure';

  return {
    artifact_type: 'deployment-report',
    environment: 'production',
    revision: revision ?? wranglerDeployRevision(deployOutput ?? '', runId),
    migrations_applied: [],
    config_changes: [
      `Production deployment executed with Wrangler command: ${deployCommand}`,
      'GitHub Actions not used as the deployment path.',
      `Release gate: ${releaseGatePath}`,
      ...(evidencePath ? [`Evidence: ${evidencePath}`] : []),
    ],
    result,
    verification: [
      ...evidenceVerification,
      {
        check: deployCommand,
        expected: 'Wrangler production deploy command exits successfully.',
        actual: deployOk ? (deployOutput ?? 'deploy completed') : (deployError ?? 'deploy failed'),
        passed: deployOk,
      },
      liveVerification,
    ],
    issues,
    next_action: result === 'success' ? 'monitor' : deployOk ? 'rollback' : 'fix',
    rollback: {
      prior_revision: 'previous Cloudflare Worker deployment',
      steps: deployOk
        ? 'Use Wrangler versions/rollback for the Worker if live verification or monitoring shows production impact.'
        : 'No production rollback is required because the Wrangler deploy command did not complete successfully.',
      data_caveats: evidence?.commands.some((command) => /\bwrangler\s+d1\b/.test(command.command))
        ? 'Release-gate database evidence was local; verify any production D1 migration state separately before rollback.'
        : undefined,
    },
  };
}

export function deploymentReportSuccessNextSteps(report: DeploymentReport, repoPath: string) {
  if (report.environment === 'local') {
    return [
      `Local Wrangler validation passed. Review the deployment report and run npm run delivery:run -- --repo ${resolve(repoPath)} --deploy production when ready to request human approval before Wrangler production deploy.`,
    ];
  }

  return [report.next_action];
}

async function runProductionWranglerDeployment({
  repoPath,
  mastra,
  stage,
  runId,
  releaseGate,
  releaseGatePath,
  evidence,
  evidencePath,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  runId: string;
  releaseGate: ReleaseGate;
  releaseGatePath: string;
  evidence?: ReleaseGateEvidence;
  evidencePath?: string;
}) {
  const command = productionWranglerDeployCommand(repoPath);
  await recordRunCodeStart({ repoPath, mastra, stage, command: command.command, timeoutMs: 300_000 });

  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: resolve(repoPath),
      timeout: 300_000,
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        NO_COLOR: '1',
        WRANGLER_SEND_METRICS: 'false',
      },
    });
    const rawOutput = `${result.stdout}\n${result.stderr}`;
    const outputSummary = compactDiagnostic(rawOutput.trim() || 'Wrangler deploy completed.', 1_200);
    const revision = wranglerDeployRevision(rawOutput, runId);
    const urls = wranglerDeployUrls(rawOutput);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'deploy',
        stage,
        target: 'production',
        revision,
        command: command.command,
        ok: true,
        output_summary: outputSummary,
        urls,
      },
    });

    const liveVerification = await productionLiveVerification(urls);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'live_verify',
        stage,
        target: 'production',
        revision,
        command: liveVerification.check,
        ok: liveVerification.passed !== false,
        output_summary: liveVerification.actual,
        urls,
      },
    });

    return productionDeploymentReportFromWranglerResult({
      runId,
      releaseGate,
      evidence,
      releaseGatePath,
      evidencePath,
      deployCommand: command.command,
      deployOk: true,
      deployOutput: outputSummary,
      liveVerification,
      revision,
    });
  } catch (error) {
    const failure = commandFailureSummary(error, 1_200);
    const revision = `production:${runId}`;
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'deploy',
        stage,
        target: 'production',
        revision,
        command: command.command,
        ok: false,
        error: failure,
      },
    });

    const liveVerification: DeploymentReport['verification'][number] = {
      check: 'production live verification',
      expected: 'Production live verification runs after a successful Wrangler deploy.',
      actual: 'Skipped because the Wrangler deploy command failed.',
      passed: false,
    };

    return productionDeploymentReportFromWranglerResult({
      runId,
      releaseGate,
      evidence,
      releaseGatePath,
      evidencePath,
      deployCommand: command.command,
      deployOk: false,
      deployError: failure,
      liveVerification,
      revision,
    });
  }
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
  buildPostWriteQuiet: envTimeoutMs('DELIVERY_BUILD_POST_WRITE_QUIET_TIMEOUT_MS', 60_000),
  judge: envTimeoutMs('DELIVERY_JUDGE_CALL_TIMEOUT_MS', 300_000),
};

const repairPostWriteQuietTimeoutMs = 8_000;
const preWriteReadBudgetBlockLimit = 2;

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

class DeliveryReadBudgetExceededError extends DeliveryStageTimeoutError {
  constructor(
    stage: string,
    readonly blockCount: number,
  ) {
    super(stage, 0, `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`);
    this.name = 'DeliveryReadBudgetExceededError';
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

const readBudgetExceededPattern = /already used \d+ read\/list tool calls before any write/i;

export function readBudgetBlockedToolCount(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  return stageSlice(events, stage).filter(
    (event) => event.type === 'tool_use' && event.ok === false && readBudgetExceededPattern.test(String(event.error ?? '')),
  ).length;
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

async function stageReadBudgetBlockedToolCount({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}) {
  try {
    return readBudgetBlockedToolCount(readDeliveryEvents(repoPath), { stage });
  } catch {
    // Fall back to Mastra storage when local projection is unavailable.
  }

  const events = await readDeliveryEventsState({ repoPath, mastra }).catch(() => []);
  return readBudgetBlockedToolCount(events, { stage });
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
  readBudgetBlockLimit,
  readBudgetBlockCheck,
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
  readBudgetBlockLimit?: number;
  readBudgetBlockCheck?: () => Promise<number>;
  operation: (abortSignal: AbortSignal) => Promise<T>;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstToolTimer: ReturnType<typeof setTimeout> | undefined;
  let postWriteQuietTimer: ReturnType<typeof setInterval> | undefined;
  let readBudgetTimer: ReturnType<typeof setInterval> | undefined;
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
  const readBudgetExceeded =
    readBudgetBlockLimit && readBudgetBlockCheck
      ? new Promise<never>((_, reject) => {
          readBudgetTimer = setInterval(() => {
            readBudgetBlockCheck()
              .then((blockCount) => {
                if (blockCount < readBudgetBlockLimit) return;
                controller.abort(
                  `Delivery stage "${stage}" exhausted the pre-write read/list budget ${blockCount} times`,
                );
                reject(new DeliveryReadBudgetExceededError(stage, blockCount));
              })
              .catch(() => undefined);
          }, 2_000);
          readBudgetTimer.unref?.();
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
      ...(readBudgetExceeded ? [readBudgetExceeded] : []),
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
              : error instanceof DeliveryReadBudgetExceededError
                ? { type: 'stage_read_budget_exceeded', stage, blocked_reads: error.blockCount }
            : { type: 'stage_timeout', stage, timeout_ms: error.timeoutMs },
      }).catch(() => undefined);
      await endDeliveryStageState({ repoPath, stage, reason: 'max_turns', mastra }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (firstToolTimer) clearTimeout(firstToolTimer);
    if (postWriteQuietTimer) clearInterval(postWriteQuietTimer);
    if (readBudgetTimer) clearInterval(readBudgetTimer);
  }
}

async function judgeDeliveryArtifact({
  mastra,
  repoPath,
  runId,
  rubricName,
  subjectName,
  subject,
  deterministicResults = [],
  slug,
}: {
  mastra: any;
  repoPath: string;
  runId: string;
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
            memory: deliveryRunMemory({ repoPath, runId, role: 'judge' }),
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
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
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
    if (inputData.repoPath) await safePersistDeliveryStateWithMastra({ repoPath: inputData.repoPath, mastra });
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
    const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
    const cachedOutput = readCachedPlannerOutput({
      repoPath: inputData.repoPath,
      sourceFingerprint,
      sourcePolicy,
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
Project policy:
- This harness is for Chris's standalone Cloudflare Worker projects. Do not plan desktop apps, mobile apps, generic Node servers, React/Vite apps, or Cloudflare Pages unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Default new projects to a vanilla JavaScript Worker module entry, Wrangler config, and vanilla HTML/CSS/JS under public/ when a UI is needed. Use TypeScript only when the existing repo or source docs explicitly require TypeScript.
- Prefer wrangler.jsonc for new Worker config unless the repo already has wrangler.toml or the source docs explicitly require TOML.
- New Worker config must define env.staging and env.production. Mirror required bindings and vars inside both environments because Wrangler does not inherit them across environments.
- Use wrangler CLI for deploy and local runtime validation; never use GitHub Actions as the deployment path.
- If vanilla UI files are planned under public/, configure Workers Static Assets in Wrangler with assets.directory "./public" and binding "ASSETS"; do not use Pages or a frontend build to serve them.
- Git/gh may support source-control steps, but production deployment is a separate Wrangler action after human approval: wrangler deploy --env production.
- New Worker config must use compatibility_date "${todayIsoDate()}" unless the source docs explicitly require a different recent date.
Every task must have checkable acceptance criteria and owned_surfaces.
Worker task slicing:
- For a brand-new Worker project, the first root engineer scaffold task must own package.json, .gitignore, wrangler.jsonc, and the Worker entrypoint so Wrangler dry-run validation can run from the first build slice.
- Keep D1 schema/migration work separate from Worker config: migrations/*.sql belongs in a later task after the root scaffold/config task.
- Include an engineer-owned README.md operator documentation task near the end. It must document local Wrangler validation, required Cloudflare resources/bindings/secrets, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.
- When a deliverable is split into generated slices such as T05, T05-part-2, and T05-part-3, downstream tasks outside that slice family must depend on the final slice ID, not the first or middle slice.
Owned-surface hygiene:
- Every owned_surfaces entry must be a concrete repo path, for example wrangler.jsonc, wrangler.toml, src/index.js, workers/tally.js, public/settings.html, migrations/0001_schema.sql.
- Do not use wildcards such as src/**/*.ts, src/storage/*.ts, public/**, or src/**. Enumerate each expected file path.
- Do not use conceptual labels such as "Worker Env types", "wrangler configuration", "Workflow binding registration", "API routes", or "UI assets".
- If the exact file is genuinely unknowable, use "unknown: <why>" instead of a label.
Role-boundary hygiene:
- Engineer tasks own Worker config/source/migration files such as package.json, tsconfig.json when TypeScript is used, wrangler.jsonc, wrangler.toml when existing or source-required, src/**, workers/**, and migrations/**.
- Designer tasks own static UI files such as public/index.html, public/styles.css, public/app.js, and assets/**.
- Do not put public/** files in engineer-owned tasks; create or reuse a designer task for vanilla HTML/CSS/JS UI work.
- Do not plan functions/** owned surfaces unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
Root scaffold hygiene:
- Target package.json is ${repoScaffoldState.packageJson}; target tsconfig.json is ${repoScaffoldState.tsconfigJson}.
- If package.json is missing and the plan creates a standalone Worker project, the first root engineer task must own package.json, .gitignore, wrangler.jsonc, and at least one concrete Worker source entry such as src/index.js or workers/app.js. Include tsconfig.json only when the Worker source is TypeScript.
- Worker runtime/config/source/static asset/migration tasks must depend on that scaffold task unless they own package.json and the Worker source entry themselves.
Open-decision hygiene:
- taskPlan.open_decisions is only for genuine blockers that prevent a task from being implemented safely.
- Do not stop for preferences the harness already settles: Worker over Pages unless source docs declaratively require Pages, vanilla UI over frameworks, Wrangler over GitHub Actions deploy, local validation before production, or Workers AI binding shape.
- If an unknown can be resolved by a safe default, put it in readout.safe_assumptions, not taskPlan.open_decisions.
- If an unknown is a non-blocking delivery concern, put it in taskPlan.risks.
${bookmarksAdapterPolicyLine(sourcePolicy)}
- Every open_decisions entry must be one string with this exact field shape:
  "Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
- The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.
Return only JSON matching this top-level shape: { "readout": {...}, "taskPlan": {...} }.${humanAnswers}

Source documents:
${sourceDocuments.map((document) => `--- ${document.path}\n${document.content}`).join('\n\n')}`,
                {
                  ...structuredNoToolOptions,
                  abortSignal,
                  memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'planner' }),
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
    output.readout = normalizeReadoutSafeAdapterAmbiguities(output.readout);
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
          sourcePolicy,
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
      sourcePolicy,
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
        sourcePolicy: plannerOutput.sourcePolicy,
        taskPlan: plannerOutput.taskPlan,
        questions: output.readout.blocking_ambiguities,
      },
    });

    return plannerOutput;
  },
});

function planGateRevisionRemediation({
  deterministicResults,
  judgment,
}: {
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
}) {
  const failedChecks = deterministicResults.filter((check) => !check.passed);
  if (failedChecks.length) {
    return failedChecks.map((check) => check.reason ?? 'deterministic task-plan check failed');
  }
  if (!judgment.passed) return judgment.remediation;
  return [];
}

async function reviseTaskPlanFromPlanGate({
  mastra,
  repoPath,
  runId,
  taskPlan,
  deterministicResults,
  judgment,
  revisionNumber,
}: {
  mastra: any;
  repoPath: string;
  runId: string;
  taskPlan: TaskPlan;
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
  revisionNumber: number;
}) {
  const stage = `plan:gate-repair-${revisionNumber}`;
  const revisionPath = `.delivery/artifacts/task-plan.plan-gate-revision-${revisionNumber}.json`;
  const remediation = planGateRevisionRemediation({ deterministicResults, judgment });
  const sourcePolicy = sourcePolicyFromRepo(repoPath);

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'plan_gate_revision_requested',
      stage,
      revision: String(revisionNumber),
      remediation,
    },
  });
  await startDeliveryStageState({
    repoPath,
    stage,
    role: 'planner',
    mastra,
  });

  const planner = requiredAgent(mastra, 'planner');
  let response: unknown;
  try {
    response = await runWithDeliveryStageTimeout({
      repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        planner.generate(
          `The task-plan gate failed before architect review. Revise the task plan to address the gate findings.

Return a full replacement taskPlan object. Do not write implementation code. Do not ask new human questions unless no executable Worker scaffold can be planned.

Project policy:
- This harness is for Chris's standalone Cloudflare Worker projects, not desktop apps, mobile apps, generic Node servers, React/Vite apps, or Cloudflare Pages unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Default new projects to a vanilla JavaScript Worker module entry, Wrangler config, and vanilla HTML/CSS/JS under public/ when a UI is needed. Use TypeScript only when the existing repo or source docs explicitly require it.
- Use wrangler.jsonc for new Worker config unless the repo already has wrangler.toml or the source docs explicitly require TOML.
- New Worker config must define env.staging and env.production. Mirror required bindings and vars inside both environments because Wrangler does not inherit them across environments.
- Use Wrangler CLI for local validation and deployment; never make GitHub Actions the deployment path.
- If AI is used in the target Worker, plan an active Workers AI binding and an internal adapter around it.
- If vanilla UI files are planned under public/, configure Workers Static Assets in Wrangler with assets.directory "./public" and binding "ASSETS"; do not use Pages or a frontend build to serve them.
- New Worker config must use compatibility_date "${todayIsoDate()}" unless the source docs explicitly require a different recent date.

Task-plan quality requirements:
- For a brand-new Worker project, the first root engineer scaffold task must own package.json, .gitignore, wrangler.jsonc, and the Worker entrypoint so Wrangler dry-run validation can run from the first build slice.
- Keep D1 schema/migration work separate from Worker config: migrations/*.sql belongs in a later task after the root scaffold/config task.
- Include an engineer-owned README.md operator documentation task near the end for local Wrangler validation, Cloudflare resources/bindings/secrets, local git checkpoints, explicit human direction before gh push/PR actions, and human-approved wrangler deploy --env production.
- When a deliverable is split into generated slices such as T05, T05-part-2, and T05-part-3, downstream tasks outside that slice family must depend on the final slice ID, not the first or middle slice.
- Preserve concrete deliverables, checkable acceptance criteria, owned surfaces, and task owner boundaries.
- Do not delete prior acceptance criteria during a repair. If you split or narrow a task, copy each prior criterion verbatim into source_acceptance_criteria on the slice or revised task that carries the original contract.
- Every consumes-output relation must be declared by task ID. If a later task uses storage, prompts, routes, services, generated types, bindings, or workflow steps from an earlier slice, add the dependency edge explicitly.
- Every taskPlan.tasks[].owned_surfaces entry must be a concrete repo path, not a conceptual label or wildcard. Use "unknown: <why>" only when the file truly cannot be known.
- Do not plan functions/** owned surfaces unless vision.md/spec.md declaratively require Cloudflare Pages or Pages Functions.
- Keep taskPlan.open_decisions limited to genuine blockers only. Non-blocking unknowns belong in risks.
${bookmarksAdapterPolicyLine(sourcePolicy)}
- Every taskPlan.open_decisions entry must use this exact field shape:
"Topic: ... | Why it matters: ... | Options considered: ... | Follow-up impact: ..."
- The "Why it matters" or "Follow-up impact" field must name what task or implementation work is blocked.

Gate remediation:
${remediation.map((item) => `- ${item}`).join('\n') || '- No textual remediation was provided; satisfy all failed gates and weak dimensions.'}

Deterministic gate results:
${JSON.stringify(deterministicResults, null, 2)}

Task-plan rubric judgment:
${JSON.stringify(judgment, null, 2)}

Current task plan:
${JSON.stringify(taskPlan, null, 2)}`,
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath, runId, role: 'planner' }),
            requestContext: createDeliveryRequestContext(repoPath),
            structuredOutput: {
              schema: plannerRevisionOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
            },
          },
        ),
    });
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }

  let parsedRevision: ReturnType<typeof parsePlannerRevisionResponse>;
  try {
    parsedRevision = parsePlannerRevisionResponse(response, `plan gate revision ${revisionNumber}`);
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }
  if (parsedRevision.repairedFromBareTaskPlan) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'structured_output_repaired',
        stage,
        target: 'task-plan',
        reason: parsedRevision.repairReason,
      },
    });
  }

  const { taskPlan: revisedTaskPlan } = preserveTaskPlanAcceptanceContracts(
    taskPlan,
    normalizeTaskPlanForDelivery(repoPath, parsedRevision.revision.taskPlan),
  );
  writeDeliveryArtifact({
    repoPath,
    artifactPath: revisionPath,
    artifact: revisedTaskPlan,
  });
  writeDeliveryArtifact({
    repoPath,
    artifactPath: '.delivery/artifacts/task-plan.json',
    artifact: revisedTaskPlan,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: `task-plan:plan-gate-revision-${revisionNumber}`,
    path: revisionPath,
    mastra,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: 'task-plan',
    path: '.delivery/artifacts/task-plan.json',
    mastra,
  });
  await endDeliveryStageState({ repoPath, stage, reason: 'complete_stage', mastra });

  return {
    taskPlan: revisedTaskPlan,
    path: revisionPath,
  };
}

const createPlanGateStep = createStep({
  id: 'judge-task-plan',
  description: 'Run deterministic plan gates and rubric judgment before architect handoff.',
  inputSchema: plannerArtifactsSchema,
  outputSchema: planStageOutputSchema,
  scorers: deliveryPlanStepScorers,
  execute: async ({ inputData, mastra }) => {
    const artifacts = [...inputData.artifacts];
    const checks: CheckSummary[] = [];
    const judgments: JudgmentRef[] = [];
    let taskPlan = inputData.taskPlan;
    let subjectName = '.delivery/artifacts/task-plan.json';

    for (let attempt = 0; attempt <= inputData.maxRetries; attempt += 1) {
      const suffix = attempt === 0 ? undefined : `plan-gate-revision-${attempt}`;
      const deterministicResults = taskPlanDeterministicResults({
        repoPath: inputData.repoPath,
        taskPlan,
        sourcePolicy: inputData.sourcePolicy,
      });
      checks.push(...checkSummaries(deterministicResults, suffix));
      const taskPlanJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        rubricName: 'task-plan',
        subjectName,
        subject: taskPlan,
        deterministicResults,
        slug: attempt === 0 ? 'task-plan' : `task-plan-plan-gate-revision-${attempt}`,
      });
      const taskPlanJudgment = taskPlanJudge.judgment;
      artifacts.push(taskPlanJudge.judgeOutputPath, taskPlanJudge.judgmentPath);
      judgments.push(taskPlanJudge.ref);

      const planContext = {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        sourcePolicy: inputData.sourcePolicy,
        taskPlan,
      };

      if (shouldSuspendForPlannerQuestions(inputData.readout, taskPlan)) {
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

      const remediation = planGateRevisionRemediation({ deterministicResults, judgment: taskPlanJudgment });
      if (!remediation.length) {
        return {
          ...planContext,
          status: 'planned' as const,
          runId: inputData.runId,
          summary: taskPlan.scope,
          artifacts,
          checks,
          judgments,
          questions: inputData.readout.blocking_ambiguities,
          nextSteps: [
            ...inputData.readout.blocking_ambiguities.map((question) => `Deferred question: ${question}`),
            `Run architecture review against ${subjectName}.`,
            'Continue through the native architect review, build, release-gate, and deployment stages.',
          ],
        };
      }

      if (attempt >= inputData.maxRetries) {
        const deterministicFailed = deterministicResults.some((check) => !check.passed);
        return {
          ...planContext,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: deterministicFailed
            ? 'Planner produced artifacts, but deterministic plan checks failed after repair attempts.'
            : 'Planner produced artifacts, but the task-plan rubric judgment failed after repair attempts.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
        };
      }

      const revision = await reviseTaskPlanFromPlanGate({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        taskPlan,
        deterministicResults,
        judgment: taskPlanJudgment,
        revisionNumber: attempt + 1,
      });
      const regression = taskPlanAcceptanceContractRegression(taskPlan, revision.taskPlan);
      checks.push(...checkSummaries([{ id: 'acceptance_contracts_preserved', check: 'task_plan_acceptance_contract_regression', ...regression }], `plan-gate-revision-${attempt + 1}`));
      if (!regression.passed) {
        return {
          ...planContext,
          taskPlan: revision.taskPlan,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Planner revision dropped acceptance criteria from the prior task plan.',
          artifacts: [...artifacts, revision.path],
          checks,
          judgments,
          questions: [],
          nextSteps: [regression.reason],
        };
      }
      taskPlan = revision.taskPlan;
      subjectName = revision.path;
      artifacts.push(revision.path);
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Planner could not produce a task plan before the retry budget ended.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Inspect the plan-gate judgments and task-plan revision artifacts.'],
    };
  },
});

export const deliveryPlanningWorkflow = createWorkflow({
  id: 'delivery-planning',
  description: 'Plan a delivery run, repair the task plan, and persist the plan-stage state.',
  inputSchema: workflowInputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(initializeRunStep)
  .then(createPlannerArtifactsStep)
  .then(createPlanGateStep)
  .then(syncPlanStateStep)
  .commit();

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
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'architect' }),
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
      runId: inputData.runId,
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
Do not delete prior acceptance criteria during a revision. If you split or narrow a task, copy each prior criterion verbatim into source_acceptance_criteria on the slice or revised task that carries the original contract.
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
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'planner' }),
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
    const { taskPlan: revisedTaskPlan } = preserveTaskPlanAcceptanceContracts(
      taskPlan,
      normalizeTaskPlanForDelivery(inputData.repoPath, revision.taskPlan),
    );
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
      sourcePolicy: inputData.sourcePolicy,
    });
    const contractRegression = taskPlanAcceptanceContractRegression(taskPlan, revisedTaskPlan);
    const revisedResultsWithContracts = [
      ...revisedDeterministicResults,
      {
        id: 'acceptance_contracts_preserved',
        check: 'task_plan_acceptance_contract_regression',
        ...contractRegression,
      },
    ];
    checks.push(...checkSummaries(revisedResultsWithContracts, `revision-${revisionNumber}`));
    const failedRevisedChecks = revisedResultsWithContracts.filter((check) => !check.passed);
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
      runId: inputData.runId,
      rubricName: 'task-plan',
      subjectName: revisionPath,
      subject: revisedTaskPlan,
      deterministicResults: revisedResultsWithContracts,
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

export const deliveryReviewWorkflow = createWorkflow({
  id: 'delivery-review',
  description: 'Run the architect review loop and persist the reviewed delivery state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(prepareReviewLoopStep)
  .dountil(executeReviewAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReviewLoopStep)
  .then(syncReviewStateStep)
  .commit();

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
      reviewMode: inputData.reviewMode,
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
      taskId: inputData.task?.id,
      taskIndex: inputData.taskIndex,
      skipped: inputData.skipped,
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
        reviewMode: inputData.reviewMode,
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
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
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
        reviewMode: inputData.reviewMode,
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
        task,
        taskIndex: inputData.taskIndex,
        skipped: false,
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
        reviewMode: inputData.reviewMode,
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
      reviewMode: inputData.reviewMode,
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
    const verificationFailureDiagnostics = typeScriptDiagnosticsFromRemediation(inputData.remediation);
    const focusedRepairFileContext = replaceStubsRecovery || focusedRepairRecovery
      ? repoFileContents(inputData.repoPath, focusedRepairContextPaths(taskPlan, task, usableSurfaces))
      : [];
    const taskPacket = {
      scope: taskPlan.scope,
      task,
      acceptance_contracts: taskAcceptanceContractCriteria(task).map((criterion, index) => ({
        id: acceptanceContractId(task, index),
        criterion,
        status: 'required',
      })),
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
      verification_failure_diagnostics: verificationFailureDiagnostics,
      package_manifest_owned: packageManifestOwned,
      existing_package_dependencies: existingPackageDependencies,
      focused_repair_file_context: focusedRepairFileContext,
      worker_config_policy: workerConfigTaskPacketPolicyForTask(task),
      profile_kind_policy: profileKindTaskPacketPolicyForTask(task, inputData.sourcePolicy),
      platform_policy_findings: [
        ...workersAiBindingGaps(inputData.repoPath, task),
        ...workerConfigHygieneGaps(inputData.repoPath, task),
        ...workerPackageScaffoldGaps(inputData.repoPath, task),
      ],
      domain_contract_findings: profileKindContractGaps(inputData.repoPath, task),
    };

    const buildPrompt = `Implement build task ${task.id}.

Use this task packet as the source of truth. Do not reread .delivery planning or review artifacts unless a specific required field is missing from the packet.

Task packet:
${JSON.stringify(taskPacket, null, 2)}

Execution rules:
- Make the smallest coherent code change for this task.
- Treat task_packet.acceptance_contracts as mandatory contracts. Do not return until every listed AC has concrete code evidence in the task's boundary surfaces, or until you surface a real blocker.
- Do not replace a product acceptance contract with a weaker "slice completed" claim. If the contract names behavior, implement the behavior or leave the task incomplete.
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
- If verification_failure_diagnostics is non-empty, fix each listed file/line diagnostic directly before any other cleanup.
- In write-first or focused repair mode, you must call an available workspace write/edit tool before returning; a text-only response is a failed attempt.
- If failure_class is missing_surface, create every missing_owned_surface before editing any other file.
- If failure_class is preflight_stub, replace every unreplaced_preflight_stub before editing any other file.
- If failure_class is policy_boundary, do not repeat blocked writes; use only normalized boundary_surfaces paths.
- Do not introduce runtime dependencies that are absent from existing_package_dependencies unless package_manifest_owned is true and you update the package manifest in this task.
- If verification says a module cannot be found, prefer the existing Worker/router pattern or native Web/Cloudflare APIs over adding a new dependency.
- For TS18046 on unknown values, narrow with typeof/asRecord/Array.isArray before property access or numeric comparison. Number.isInteger(value) alone does not narrow unknown to number.
- Treat platform_policy_findings as mandatory corrections, even when the original task text is stale.
- Treat domain_contract_findings as mandatory corrections, even when TypeScript is already passing.
- When worker_config_policy is not null, use the policy exactly: wrangler.jsonc for new projects, "$schema" from worker_config_policy.schema, compatibility_date from worker_config_policy.compatibility_date, compatibility_flags including "nodejs_compat", explicit observability enabled with head_sampling_rate, Workers Static Assets from worker_config_policy.static_assets when public/ UI files exist, worker_config_policy.deployment_environments with env.staging/env.production and the listed staging/prod Wrangler commands, worker_config_policy.generated_types for TypeScript source, and Wrangler binding names that exactly match generated Env binding property names.
- For Worker scaffolds, use current Cloudflare tooling: Wrangler "latest" or v4+, scripts.dev as "wrangler dev --env staging", and scripts.deploy as "wrangler deploy --env production". For TypeScript Worker source, add scripts.generate-types as "wrangler types", scripts.typecheck as "npm run generate-types && tsc --noEmit", @types/node, and tsconfig.json. Do not add @cloudflare/workers-types; Wrangler generates Worker binding/runtime types from config.
- Do not add React, Vite, Next, Vue, Svelte, or frontend build dependencies/scripts. Chris's Worker frontends are vanilla HTML/CSS/JS served as static assets.
- When TypeScript is used, configure tsconfig.json for Workers: target ES2022 or newer, module ESNext, moduleResolution Bundler, lib includes ES2022+ and WebWorker, types includes ./worker-configuration.d.ts and node, and strict is true.
- .gitignore must exclude node_modules/, .wrangler/, .delivery/, .dev.vars*, .env*, and *.cpuprofile.
- For placeholder Worker route/error responses, include actionable next steps such as available route expectations, pending setup, or the next implementation surface instead of only returning "not found".
- When profile_kind_policy is not null, use it exactly: PROFILE_KINDS must include every value in profile_kind_policy.required_persistent_kinds as persistent profile kind values; do not substitute generic creator, voice, audience, topic, or R2 artifact object categories.
- For lifecycle/status storage, make state explicit: constrained status values, timestamps, query indexes, and failed/stuck states when the lifecycle can fail. Schema tasks must encode this in D1 CHECK constraints and indexes, not only TypeScript constants.
- For route tasks, integrate new endpoints through the existing Worker router/barrel/middleware path. Do not import route handlers into the Worker entrypoint and dispatch them before routeRequest when routeRequest already exists.
- If failure_class is judge_timeout, preserve working code and make only the smallest evidence-improving or obvious correctness edit before the workflow retries judgment.
- Do not inspect node_modules; rely on project types and workflow verification.
- If timeout recovery is active, do not investigate. Create the missing owned surfaces immediately.
- After you have written or edited the task's owned surfaces, stop reading/listing files and return your summary so the workflow can typecheck and judge the result.
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
- Resolve every verification_failure_diagnostic before returning:
${verificationFailureDiagnostics.map((item) => `  - ${item.path}:${item.line}:${item.column} ${item.code} ${item.message}`).join('\n') || '  - none'}
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
    const postWriteQuietTimeoutMs =
      writeFirstRecovery || replaceStubsRecovery || focusedRepairRecovery
        ? Math.min(deliveryAgentTimeouts.buildPostWriteQuiet, repairPostWriteQuietTimeoutMs)
        : deliveryAgentTimeouts.buildPostWriteQuiet;
    let buildResponse: unknown;
    try {
      buildResponse = await runWithDeliveryStageTimeout({
        repoPath: inputData.repoPath,
        mastra,
        stage,
        timeoutMs: deliveryAgentTimeouts.build,
        firstToolTimeoutMs: deliveryAgentTimeouts.buildNoTool,
        firstToolCheck: () => stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage }),
        postWriteQuietTimeoutMs,
        latestWriteCheck: () => latestStageSuccessfulWriteTimestamp({ repoPath: inputData.repoPath, mastra, stage }),
        readBudgetBlockLimit: preWriteReadBudgetBlockLimit,
        readBudgetBlockCheck: () => stageReadBudgetBlockedToolCount({ repoPath: inputData.repoPath, mastra, stage }),
        operation: (abortSignal) =>
          agent.generate(
            finalBuildPrompt,
            {
              abortSignal,
              activeTools,
              toolChoice,
              maxSteps,
              toolCallConcurrency: 1,
              memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: task.owner }),
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
        readBudgetExceeded: error instanceof DeliveryReadBudgetExceededError,
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
          reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
          reviewMode: inputData.reviewMode,
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
          reviewMode: inputData.reviewMode,
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
          reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
        runId: inputData.runId,
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
          reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
          reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
      reviewMode: inputData.reviewMode,
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
    reviewMode: inputData.reviewMode,
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
        reviewMode: first.reviewMode,
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
        reviewMode: first.reviewMode,
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
      reviewMode: first.reviewMode,
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

export const deliveryBuildWorkflow = createWorkflow({
  id: 'delivery-build',
  description: 'Prepare implementation tasks, run the nested build-task workflow, and persist build-stage state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(prepareBuildTasksStep)
  .foreach(deliveryBuildTaskWorkflow, { concurrency: 1 })
  .then(aggregateBuildTaskResultsStep)
  .then(syncBuildStateStep)
  .commit();

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
      remediation: [],
    });

    if (inputData.status !== 'built') return passThrough();
    if (!inputData.taskPlan) throw new Error('build stage did not provide a task plan for release gating');

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
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'tester' }),
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
      evidence,
    });
    checks.push(...checkSummaries(deterministicResults, `release-gate.a${attemptNumber}`));

    const gateJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
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
          reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
        reviewMode: inputData.reviewMode,
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
      reviewMode: inputData.reviewMode,
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

export const deliveryReleaseGateWorkflow = createWorkflow({
  id: 'delivery-release-gate',
  description: 'Collect release evidence, run tester release-gate retries, and persist release readiness state.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(prepareReleaseGateLoopStep)
  .dountil(executeReleaseGateAttemptStep, async ({ inputData }) => inputData.terminal)
  .then(finalizeReleaseGateLoopStep)
  .then(syncReleaseGateStateStep)
  .commit();

const createDeploymentReportStep = createStep({
  id: 'create-deployment-report',
  description: 'Run the native deployment stage from a passing release gate and write the deployment report artifact.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: deploymentReportStageSchema,
  resumeSchema: deploymentApprovalResumeSchema,
  suspendSchema: deploymentApprovalSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend }) => {
    if (inputData.status !== 'release_ready') return inputData;
    if (!inputData.releaseGate) throw new Error('release gate stage did not provide a gate for deployment');

    const artifacts = [...inputData.artifacts];
    const stage = 'deploy';
    const releaseGatePath = latestArtifactPath(artifacts, 'release-gate', '.delivery/artifacts/release-gate.json');
    const evidencePath = latestReleaseGateEvidencePath(artifacts);

    if (inputData.deployMode === 'production' && !resumeData) {
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
          reason: 'Production deployment requires human approval before the native Wrangler deploy command runs.',
          deployMode: 'production' as const,
          releaseGatePath,
          releaseGateSummary: inputData.releaseGate.summary,
          blockers: inputData.releaseGate.blockers,
          nextSteps: inputData.nextSteps,
        },
        { resumeLabel: 'approve-production-deployment' },
      );
    }

    if (inputData.deployMode === 'production' && resumeData?.approved === false) {
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
        summary: 'Production deployment was rejected by human approval.',
        nextSteps: resumeData.notes ? [resumeData.notes] : ['Deployment rejected before any production deploy command ran.'],
      };
    }

    if (inputData.deployMode === 'production' && resumeData?.approved) {
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

    if (inputData.deployMode === 'local') {
      const evidence = readReleaseGateEvidenceArtifact(inputData.repoPath, artifacts);
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'deploy',
          stage,
          target: 'local',
          revision: `local:${inputData.runId}`,
          command: 'local release gate accepted; no production Wrangler deploy executed',
          ok: true,
        },
      });
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'live_verify',
          stage,
          target: 'local',
          revision: `local:${inputData.runId}`,
          artifact_type: 'test-evidence',
          path: evidencePath,
          ok: inputData.releaseGate.decision === 'pass' && inputData.releaseGate.blockers.length === 0,
          output_summary: evidencePath
            ? `Local verification reused passing release-gate evidence from ${evidencePath}.`
            : 'Local verification reused the passing release gate; no separate evidence artifact was found.',
        },
      });

      const report = localDeploymentReportFromReleaseGateEvidence({
        runId: inputData.runId,
        releaseGate: inputData.releaseGate,
        evidence,
        releaseGatePath,
        evidencePath,
      });
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
    }

    const evidence = readReleaseGateEvidenceArtifact(inputData.repoPath, artifacts);
    const report = await runProductionWranglerDeployment({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      runId: inputData.runId,
      releaseGate: inputData.releaseGate,
      releaseGatePath,
      evidence,
      evidencePath,
    });
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
      runId: inputData.runId,
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
      nextSteps: complete
        ? deploymentReportSuccessNextSteps(inputData.deploymentReport, inputData.repoPath)
        : deploymentJudge.judgment.remediation,
    };
  },
});

export const deliveryDeploymentWorkflow = createWorkflow({
  id: 'delivery-deployment',
  description: 'Run local or approved production deployment, judge the deployment report, and finish the run.',
  inputSchema: deliveryStageOutputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(createDeploymentReportStep)
  .then(syncDeploymentReportStateStep)
  .then(createDeploymentJudgmentStep)
  .then(syncFinalDeliveryStateStep)
  .commit();

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description:
    'Native Delivery Engine workflow: initialize run state, plan, review, build, release-gate, deploy, and finish.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
})
  .then(deliveryPlanningWorkflow)
  .then(deliveryReviewWorkflow)
  .then(deliveryBuildWorkflow)
  .then(deliveryReleaseGateWorkflow)
  .then(deliveryDeploymentWorkflow)
  .commit();
