import { z } from 'zod';
import { scaffoldManifestSchema, scaffoldSurfaceKindSchema, testRuntimeKindSchema } from './project-factory/schemas';
import { deliveryWorkflowNormalizedInputSchema } from './run-input';

export const taskKindSchema = z.enum([
  'product',
  'scaffold',
  'contract',
  'worker',
  'frontend',
  'storage',
  'provider-adapter',
  'workflow',
  'evidence',
  'operator-docs',
]);

export const evidenceKindSchema = z.enum([
  'none',
  'contract',
  'validation',
  'api-route',
  'frontend',
  'provider-adapter',
  'worker-smoke',
  'local-gate',
]);

export const taskMetadataSchema = z.object({
  task: z.object({ kind: taskKindSchema }).optional(),
  surface: z.object({ kind: scaffoldSurfaceKindSchema }).optional(),
  evidence: z.object({ kind: evidenceKindSchema }).optional(),
  runtime: z.object({ kind: testRuntimeKindSchema }).optional(),
  scaffold: z
    .object({
      owned_by_factory: z.boolean(),
      generated_files: z.array(z.string()).default([]),
    })
    .optional(),
});

export const taskSchema = z.object({
  id: z.string(),
  owner: z.enum(['engineer', 'designer']),
  deliverable: z.string(),
  depends_on: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  owned_surfaces: z.array(z.string()),
  source_task_id: z.string().optional(),
  source_acceptance_criteria: z.array(z.string()).optional(),
  metadata: taskMetadataSchema.optional(),
});

export const readoutSchema = z.object({
  artifact_type: z.literal('readout'),
  product_intent: z.string(),
  technical_shape: z.string(),
  safe_assumptions: z.array(z.string()),
  blocking_ambiguities: z.array(z.string()),
  recommended_next_step: z.string(),
});

export const taskPlanSchema = z.object({
  artifact_type: z.literal('task-plan'),
  scope: z.string(),
  tasks: z.array(taskSchema),
  technology_decisions: z.array(z.object({ decision: z.string(), rationale: z.string() })).default([]),
  open_decisions: z.array(z.string()),
  risks: z.array(z.string()),
});

export const reviewFindingSchema = z.object({
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  location: z.string().optional(),
  evidence: z.string(),
  why_it_matters: z.string(),
  required_remediation: z.string(),
});

export const reviewFindingsSchema = z.array(reviewFindingSchema);

export const reviewReportSchema = z.object({
  artifact_type: z.literal('review-report'),
  verdict: z.enum(['approved', 'approved_with_conditions', 'blocked']),
  findings: reviewFindingsSchema,
  conditions: z.array(z.string()).default([]),
  residual_risks: z.array(z.string()),
  recommended_next_step: z.string(),
});

export const acceptanceContractSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  status: z.enum(['verified', 'unverified']),
  evidence: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
});

export const implementationNoteSchema = z.object({
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

export const releaseGateSchema = z.object({
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

export const deploymentReportSchema = z.object({
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

export const plannerOutputSchema = z.object({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
});

export const sourcePolicySchema = z.object({
  pagesRequired: z.boolean().default(false),
  requiredProfileKinds: z.array(z.string()).default([]),
  latestTranscriptRequired: z.boolean().default(false),
  shortLinkLifecycleRequired: z.boolean().default(false),
  externalServiceBindings: z.array(z.string()).default([]),
});

export const plannerCacheSchema = z.object({
  sourceFingerprint: z.string(),
  policyVersion: z.string().optional(),
  createdAt: z.string(),
});

export const testerOutputSchema = z.object({
  gate: releaseGateSchema,
});

export const plannerRevisionOutputSchema = z.object({
  taskPlan: taskPlanSchema,
});

export const initializedSchema = deliveryWorkflowNormalizedInputSchema.extend({
  runId: z.string(),
});

export const plannerArtifactsSchema = initializedSchema.extend({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
  artifacts: z.array(z.string()),
  sourcePolicy: sourcePolicySchema,
});

export const plannerQuestionAnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

export const plannerQuestionsResumeSchema = z.object({
  answers: z.array(plannerQuestionAnswerSchema).min(1),
  notes: z.string().optional(),
});

export const plannerQuestionsSuspendSchema = z.object({
  reason: z.string(),
  questions: z.array(z.string()),
  recommendedNextStep: z.string(),
  readoutPath: z.string(),
  taskPlanPath: z.string(),
});

export const judgmentRefSchema = z.object({
  subject: z.string(),
  rubric: z.string(),
  path: z.string(),
  overall: z.number(),
  passed: z.boolean(),
});

export const workflowStatusSchema = z.enum([
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

export const checkSummarySchema = z.object({ check: z.string(), passed: z.boolean(), reason: z.string() });

export const workflowOutputSchema = z.object({
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

export const deliveryWorkflowStateSchema = z.object({
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
  scaffoldManifest: scaffoldManifestSchema.optional(),
  scaffoldManifestPath: z.string().optional(),
  taskPlan: taskPlanSchema.optional(),
  releaseGate: releaseGateSchema.optional(),
  deploymentReport: deploymentReportSchema.optional(),
  deploymentReportPath: z.string().optional(),
});

export const deliveryStageOutputSchema = workflowOutputSchema.extend({
  repoPath: z.string(),
  maxRetries: z.number().int().min(0),
  deployMode: z.enum(['local', 'production']),
  reviewMode: z.enum(['fast', 'thorough']).default('thorough'),
  sourcePolicy: sourcePolicySchema.optional(),
  scaffoldManifest: scaffoldManifestSchema.optional(),
  scaffoldManifestPath: z.string().optional(),
  taskPlan: taskPlanSchema.optional(),
  releaseGate: releaseGateSchema.optional(),
});

export const reviewLoopStateSchema = deliveryStageOutputSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
});

export const buildTaskWorkItemSchema = deliveryStageOutputSchema.extend({
  task: taskSchema.optional(),
  taskIndex: z.number().int().min(0).default(0),
  skipped: z.boolean().default(false),
});

export const buildTaskAttemptStateSchema = buildTaskWorkItemSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
  taskId: z.string().optional(),
  taskStatus: z.enum(['complete', 'stuck', 'blocked', 'skipped']).optional(),
  remediation: z.array(z.string()).default([]),
});

export const buildTaskWorkItemsSchema = z.array(buildTaskWorkItemSchema);

export const buildTaskResultSchema = deliveryStageOutputSchema.extend({
  taskId: z.string().optional(),
  taskStatus: z.enum(['complete', 'stuck', 'blocked', 'skipped']).optional(),
});

export const buildTaskResultsSchema = z.array(buildTaskResultSchema);

export const releaseGateLoopStateSchema = deliveryStageOutputSchema.extend({
  attempt: z.number().int().min(0).default(0),
  terminal: z.boolean().default(false),
  remediation: z.array(z.string()).default([]),
});

export const deploymentReportStageSchema = deliveryStageOutputSchema.extend({
  deploymentReport: deploymentReportSchema.optional(),
  deploymentReportPath: z.string().optional(),
});

export const deploymentApprovalResumeSchema = z.object({
  approved: z.boolean(),
  approver: z.string().optional(),
  notes: z.string().optional(),
});

export const deploymentApprovalSuspendSchema = z.object({
  reason: z.string(),
  deployMode: z.literal('production'),
  releaseGatePath: z.string(),
  releaseGateSummary: z.string(),
  blockers: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

export const planStageOutputSchema = deliveryStageOutputSchema;

export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type TaskMetadata = z.infer<typeof taskMetadataSchema>;
export type Readout = z.infer<typeof readoutSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;
export type ImplementationNote = z.infer<typeof implementationNoteSchema>;
export type ReleaseGate = z.infer<typeof releaseGateSchema>;
export type DeploymentReport = z.infer<typeof deploymentReportSchema>;
export type JudgmentRef = z.infer<typeof judgmentRefSchema>;
export type Task = z.infer<typeof taskSchema>;
export type SourcePolicy = z.infer<typeof sourcePolicySchema>;
export type DeliveryWorkflowState = z.infer<typeof deliveryWorkflowStateSchema>;
export type CheckSummary = { check: string; passed: boolean; reason: string };
