import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
import { writeDeliveryArtifact, type DeliveryRunStatus } from './state';
import {
  dependencyGraphAcyclic,
  noBcryptWeakHash,
  planSchemaComplete,
  runDeterministicCheck,
  type DeliveryEvent,
} from './checks';
import { createDeliveryRequestContext } from './context';
import {
  aggregateJudgment,
  buildJudgeArtifactPrompt,
  judgeOutputSchema,
  loadDeliveryEngineRubric,
  type DeterministicGateResult,
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

const workflowInputSchema = z.object({
  repoPath: z.string().describe('Absolute path to the target repo.'),
  visionPath: z.string().describe('Path to vision.md inside repoPath; relative paths are resolved under repoPath.'),
  specPath: z.string().describe('Path to spec.md inside repoPath; relative paths are resolved under repoPath.'),
  maxRetries: z.number().int().min(0).default(2),
  deployMode: z.enum(['mock', 'real']).default('mock'),
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

const implementationNoteSchema = z.object({
  artifact_type: z.literal('implementation-note'),
  task: z.string(),
  changes: z.array(z.string()).min(1),
  files_touched: z.array(z.string()).min(1),
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

const builderOutputSchema = z.object({
  note: implementationNoteSchema,
});

const testerOutputSchema = z.object({
  gate: releaseGateSchema,
});

const deployerOutputSchema = z.object({
  report: deploymentReportSchema,
});

const plannerRevisionOutputSchema = z.object({
  taskPlan: taskPlanSchema,
});

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

const taskPlanDeterministicResults = (taskPlan: TaskPlan): DeterministicGateResult[] => [
  { id: 'tasks_structurally_complete', check: 'plan_schema_complete', ...planSchemaComplete(taskPlan) },
  { id: 'no_circular_dependencies', check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(taskPlan) },
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

const implementationFindingSteps = (taskId: string, remediation: string[]) =>
  remediation.length ? remediation : [`${taskId} did not produce a passing implementation judgment`];

function repoFileContents(repoPath: string, paths: string[]) {
  return paths
    .map((path) => {
      const fullPath = isAbsolute(path) ? path : join(resolve(repoPath), path);
      if (!existsSync(fullPath)) return undefined;
      return {
        path,
        content: readFileSync(fullPath, 'utf8'),
      };
    })
    .filter((file): file is { path: string; content: string } => Boolean(file));
}

function implementationDeterministicResults({
  repoPath,
  stage,
  role,
  note,
  events,
}: {
  repoPath: string;
  stage: string;
  role: 'engineer' | 'designer';
  note: ImplementationNote;
  events: DeliveryEvent[];
}): DeterministicGateResult[] {
  const files = repoFileContents(repoPath, note.files_touched);
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

  return [
    { id: 'file_ownership', check: 'write_paths_in_boundary', ...ownership },
    { id: 'module_loads', check: 'ran_code_before_complete', ...moduleLoads },
    { id: 'crypto_compliance', check: 'no_bcrypt_weak_hash', ...crypto },
  ];
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
  const response = await judge.generate(
    buildJudgeArtifactPrompt({
      rubric,
      subjectName,
      subject,
      deterministicResults,
    }),
    {
      requestContext: createDeliveryRequestContext(repoPath),
      structuredOutput: {
        schema: judgeOutputSchema,
        ...deliveryStructuredOutputOptions,
        instructions: 'Return only the judge gates and dimensions. Do not compute aggregate scores.',
      },
    },
  );

  const judgeOutput = parseDeliveryStructuredOutput(judgeOutputSchema, response, `${subjectName} judge`);
  const judgeOutputPath = `.delivery/artifacts/judgments/${slug}.judge.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgeOutputPath,
    artifact: judgeOutput,
  });

  const judgment = aggregateJudgment({
    rubric,
    judgeOutput,
    deterministicResults,
  });
  const judgmentPath = `.delivery/artifacts/judgments/${slug}.judgment.json`;
  writeDeliveryArtifact({
    repoPath,
    artifactPath: judgmentPath,
    artifact: judgment,
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

    const response = await planner.generate(
      `Read ${inputData.visionPath} and ${inputData.specPath} from the workspace. Produce:
1. A readout artifact.
2. A dependency-aware task-plan artifact.

Do not write code. Ask only blocking questions. Record safe assumptions in the readout.
Task owners must be engineer or designer. Verification, release gating, and deployment happen in later workflow stages, not task rows.
Every task must have checkable acceptance criteria and owned_surfaces.${humanAnswers}`,
      {
          requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: plannerOutputSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only the structured readout and taskPlan objects.',
        },
      },
    );

    const output = parseDeliveryStructuredOutput(plannerOutputSchema, response, 'planner');

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: '.delivery/artifacts/readout.json',
      artifact: output.readout,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'readout',
      path: '.delivery/artifacts/readout.json',
      mastra,
    });

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: '.delivery/artifacts/task-plan.json',
      artifact: output.taskPlan,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'task-plan',
      path: '.delivery/artifacts/task-plan.json',
      mastra,
    });

    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      reason: output.readout.blocking_ambiguities.length ? 'escalation' : 'complete_stage',
      mastra,
    });

    if (output.readout.blocking_ambiguities.length) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
        type: 'human_input_required',
        stage: 'plan',
        questions: output.readout.blocking_ambiguities,
        },
      });
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
        artifacts: plannerOutput.artifacts,
        taskPlan: plannerOutput.taskPlan,
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
    const deterministicResults = taskPlanDeterministicResults(inputData.taskPlan);
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
      taskPlan: inputData.taskPlan,
    };

    if (inputData.readout.blocking_ambiguities.length) {
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
      questions: [],
      nextSteps: [
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

    const reviewResponse = await architect.generate(
      `Review the task plan below for structural readiness before implementation.

Evaluate granularity, error handling, trust boundaries, state authority, fail-fast behavior, data flow, security, and complexity.
Approve only when build can safely begin. Block when planner changes are required before implementation.
Every finding must be specific, evidenced, and remediable by an owning role.

Task plan:
${JSON.stringify(taskPlan, null, 2)}`,
      {
        requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: reviewReportSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only a review-report object.',
        },
      },
    );

    const reviewReport = parseDeliveryStructuredOutput(reviewReportSchema, reviewResponse, 'architect review');
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

    if (reviewReport.verdict !== 'blocked' && reviewJudge.judgment.passed) {
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

    if (!reviewJudge.judgment.passed) {
      return {
        ...stageContext(),
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Architect review report failed rubric judgment.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: reviewJudge.judgment.remediation,
        attempt,
        terminal: true,
      };
    }

    if (attempt >= inputData.maxRetries) {
      return {
        ...stageContext(),
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Architect review blocked the plan after bounded planner retries.',
        artifacts,
        checks,
        judgments,
        questions: [],
        nextSteps: [
          reviewReport.recommended_next_step,
          ...reviewReport.findings.map(
            (finding) => `${finding.severity.toUpperCase()}: ${finding.title} - ${finding.required_remediation}`,
          ),
        ],
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

    const revisionResponse = await planner.generate(
      `The architect blocked the task plan. Revise the task plan to address the review findings.

Return a full replacement taskPlan object. Preserve concrete deliverables, checkable acceptance criteria, dependencies, and owned surfaces.
Do not write implementation code.

Current task plan:
${JSON.stringify(taskPlan, null, 2)}

Architect review:
${JSON.stringify(reviewReport, null, 2)}`,
      {
        requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: plannerRevisionOutputSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
        },
      },
    );

    const revision = parseDeliveryStructuredOutput(plannerRevisionOutputSchema, revisionResponse, 'planner revision');
    const revisedTaskPlan = revision.taskPlan;
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

    const revisedDeterministicResults = taskPlanDeterministicResults(revisedTaskPlan);
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
      taskPlan: revisedTaskPlan,
      releaseGate: inputData.releaseGate,
      status: 'planned' as const,
      runId: inputData.runId,
      summary: 'Planner revised the task plan after architect review.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Rerun architect review against the revised task plan.'],
      attempt: revisionNumber,
      terminal: false,
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
      checks: inputData.checks,
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
  execute: async ({ inputData }) => {
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
    const usableSurfaces = task.owned_surfaces.filter((surface) => !/^unknown\b/i.test(surface));
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

    const buildResponse = await agent.generate(
      `Implement task ${task.id}: ${task.deliverable}

Acceptance criteria:
${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join('\n')}

Owned surfaces:
${task.owned_surfaces.map((surface) => `- ${surface}`).join('\n')}

Context artifacts:
- .delivery/artifacts/task-plan.json
- .delivery/artifacts/readout.json
- prior implementation notes under .delivery/artifacts/

${inputData.remediation.length ? `This is a bounce. Fix exactly these findings:\n${inputData.remediation.map((item) => `- ${item}`).join('\n')}\n` : ''}
Use the workspace to make the smallest coherent code change. Stay inside the active boundary. Run code or tests that verify the acceptance criteria before returning. Return an implementation note with every changed file and visible verification gaps.`,
      {
        requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: builderOutputSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only { "note": <implementation-note> } after implementation and verification.',
        },
      },
    );

    const { note } = parseDeliveryStructuredOutput(builderOutputSchema, buildResponse, `${role} build`);
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
      note,
      events: deliveryEvents,
    });
    checks.push(...checkSummaries(deterministicResults, `${task.id}.a${attemptNumber}`));

    const implementationJudge = await judgeDeliveryArtifact({
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
    artifacts.push(implementationJudge.judgeOutputPath, implementationJudge.judgmentPath);
    judgments.push(implementationJudge.ref);

    if (implementationJudge.judgment.passed) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'complete',
        owner: role,
        note: `judged ${implementationJudge.judgment.overall}`,
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
        summary: `Build task ${task.id} completed.`,
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
        attempt,
        terminal: true,
        remediation: [],
      };
    }

    const remediation = implementationFindingSteps(task.id, implementationJudge.judgment.remediation);
    if (attempt >= inputData.maxRetries) {
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
        nextSteps: implementationFindingSteps(task.id, remediation),
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

    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage,
      role: 'tester',
      mastra,
    });

    const gateResponse = await tester.generate(
      `Verify the built work and produce a release gate for pre-deployment.

Read the task plan and implementation notes under .delivery/artifacts/. Write or update tests under tests/ when useful. Run the relevant smoke, API, and E2E checks that can be executed in this repo. Log test/probe runs through workspace command execution before returning.

Known task plan:
${JSON.stringify(inputData.taskPlan, null, 2)}

${inputData.remediation.length ? `This is a bounce. Fix exactly these release-gate findings:\n${inputData.remediation.map((item) => `- ${item}`).join('\n')}\n` : ''}
Return a release-gate object with event_type "pre_deployment". Every critical area must be verified with evidence, missing and therefore blocking, or not_applicable with a reason. Fail closed on unproven critical behavior.`,
      {
        requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: testerOutputSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only { "gate": <release-gate> }.',
        },
      },
    );

    const { gate } = parseDeliveryStructuredOutput(testerOutputSchema, gateResponse, 'tester release gate');
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

    const deployResponse = await deployer.generate(
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
        requestContext: createDeliveryRequestContext(inputData.repoPath),
        structuredOutput: {
          schema: deployerOutputSchema,
          ...deliveryStructuredOutputOptions,
          instructions: 'Return only { "report": <deployment-report> } after deployment and live verification.',
        },
      },
    );

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
