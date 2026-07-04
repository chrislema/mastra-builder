import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  endDeliveryStage,
  initializeDeliveryRun,
  recordDeliveryArtifact,
  recordDeliveryJudgment,
  startDeliveryStage,
  writeDeliveryArtifact,
} from './state';
import { dependencyGraphAcyclic, planSchemaComplete } from './checks';
import {
  aggregateJudgment,
  buildJudgeArtifactPrompt,
  judgeOutputSchema,
  loadDeliveryEngineRubric,
  type DeterministicGateResult,
} from './judgment';

const deliveryModel = 'openai/gpt-5-mini';

const workflowInputSchema = z.object({
  repoPath: z.string().describe('Absolute path to the target repo.'),
  visionPath: z.string().describe('Path to vision.md, relative to repoPath unless absolute.'),
  specPath: z.string().describe('Path to spec.md, relative to repoPath unless absolute.'),
  maxRetries: z.number().int().min(0).default(2),
  deployMode: z.enum(['mock', 'real']).default('mock'),
});

const taskSchema = z.object({
  id: z.string(),
  owner: z.enum(['planner', 'architect', 'engineer', 'designer', 'tester', 'deployer']),
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

const plannerOutputSchema = z.object({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
});

const plannerRevisionOutputSchema = z.object({
  taskPlan: taskPlanSchema,
});

const initializedSchema = workflowInputSchema.extend({
  runId: z.string(),
});

const judgmentRefSchema = z.object({
  subject: z.string(),
  rubric: z.string(),
  path: z.string(),
  overall: z.number(),
  passed: z.boolean(),
});

const workflowOutputSchema = z.object({
  status: z.enum(['planned', 'reviewed', 'blocked_on_questions', 'stuck']),
  runId: z.string(),
  summary: z.string(),
  artifacts: z.array(z.string()),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), reason: z.string() })),
  judgments: z.array(judgmentRefSchema).default([]),
  questions: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()),
});

const planStageOutputSchema = workflowOutputSchema.extend({
  repoPath: z.string(),
  maxRetries: z.number().int().min(0),
  deployMode: z.enum(['mock', 'real']),
  taskPlan: taskPlanSchema.optional(),
});

type TaskPlan = z.infer<typeof taskPlanSchema>;
type ReviewReport = z.infer<typeof reviewReportSchema>;
type JudgmentRef = z.infer<typeof judgmentRefSchema>;

type CheckSummary = { check: string; passed: boolean; reason: string };

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

const requiredAgent = (mastra: any, id: string) => {
  const agent = mastra?.getAgentById(id);
  if (!agent) throw new Error(`${id} agent is not registered`);
  return agent as {
    generate: (message: string, options: Record<string, unknown>) => Promise<{ object?: unknown }>;
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
  startDeliveryStage({
    repoPath,
    stage: `judge:${slug}`,
    role: 'judge',
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
      requestContext: new RequestContext([['repoPath', repoPath]]),
      structuredOutput: {
        schema: judgeOutputSchema,
        model: deliveryModel,
        instructions: 'Return only the judge gates and dimensions. Do not compute aggregate scores.',
      },
    },
  );

  const judgeOutput = judgeOutputSchema.parse(response.object);
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
  recordDeliveryJudgment({
    repoPath,
    subject: subjectName,
    rubric: judgment.rubric,
    path: judgmentPath,
    overall: judgment.overall,
    passed: judgment.passed,
  });

  endDeliveryStage({
    repoPath,
    stage: `judge:${slug}`,
    reason: judgment.passed ? 'complete_stage' : 'escalation',
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

const initializeRunStep = createStep({
  id: 'initialize-delivery-run',
  description: 'Create .delivery run state for a delivery workflow.',
  inputSchema: workflowInputSchema,
  outputSchema: initializedSchema,
  execute: async ({ inputData }) => {
    const run = initializeDeliveryRun(inputData);
    return {
      ...inputData,
      runId: run.run_id,
    };
  },
});

const createPlanStep = createStep({
  id: 'create-readout-and-plan',
  description: 'Use the planner agent to create readout and task-plan artifacts, then run deterministic plan gates.',
  inputSchema: initializedSchema,
  outputSchema: planStageOutputSchema,
  execute: async ({ inputData, mastra }) => {
    startDeliveryStage({
      repoPath: inputData.repoPath,
      stage: 'plan',
      role: 'planner',
    });

    const planner = requiredAgent(mastra, 'planner');

    const response = await planner.generate(
      `Read ${inputData.visionPath} and ${inputData.specPath} from the workspace. Produce:
1. A readout artifact.
2. A dependency-aware task-plan artifact.

Do not write code. Ask only blocking questions. Record safe assumptions in the readout.
Task owners may be engineer or designer unless another role is genuinely required.
Every task must have checkable acceptance criteria and owned_surfaces.`,
      {
        requestContext: new RequestContext([['repoPath', inputData.repoPath]]),
        structuredOutput: {
          schema: plannerOutputSchema,
          model: deliveryModel,
          instructions: 'Return only the structured readout and taskPlan objects.',
        },
      },
    );

    const output = plannerOutputSchema.parse(response.object);

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: '.delivery/artifacts/readout.json',
      artifact: output.readout,
    });
    recordDeliveryArtifact({
      repoPath: inputData.repoPath,
      type: 'readout',
      path: '.delivery/artifacts/readout.json',
    });

    writeDeliveryArtifact({
      repoPath: inputData.repoPath,
      artifactPath: '.delivery/artifacts/task-plan.json',
      artifact: output.taskPlan,
    });
    recordDeliveryArtifact({
      repoPath: inputData.repoPath,
      type: 'task-plan',
      path: '.delivery/artifacts/task-plan.json',
    });

    endDeliveryStage({
      repoPath: inputData.repoPath,
      stage: 'plan',
      reason: output.readout.blocking_ambiguities.length ? 'escalation' : 'complete_stage',
    });

    const deterministicResults = taskPlanDeterministicResults(output.taskPlan);
    const checks = checkSummaries(deterministicResults);
    const taskPlanJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      rubricName: 'task-plan',
      subjectName: '.delivery/artifacts/task-plan.json',
      subject: output.taskPlan,
      deterministicResults,
      slug: 'task-plan',
    });
    const taskPlanJudgment = taskPlanJudge.judgment;
    const artifacts = [
      '.delivery/artifacts/readout.json',
      '.delivery/artifacts/task-plan.json',
      taskPlanJudge.judgeOutputPath,
      taskPlanJudge.judgmentPath,
    ];
    const judgments = [taskPlanJudge.ref];
    const planContext = {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      taskPlan: output.taskPlan,
    };

    if (output.readout.blocking_ambiguities.length) {
      return {
        ...planContext,
        status: 'blocked_on_questions' as const,
        runId: inputData.runId,
        summary: output.readout.recommended_next_step,
        artifacts,
        checks,
        judgments,
        questions: output.readout.blocking_ambiguities,
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
      summary: output.taskPlan.scope,
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: [
        'Run architecture review against .delivery/artifacts/task-plan.json.',
        'Wire the review/build/test/deploy stages into this native workflow next.',
      ],
    };
  },
});

const createReviewStep = createStep({
  id: 'architect-review',
  description: 'Review the task plan with the architect, judge the review report, and bounce blocked plans to planner.',
  inputSchema: planStageOutputSchema,
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const passThrough = () => ({
      status: inputData.status,
      runId: inputData.runId,
      summary: inputData.summary,
      artifacts: inputData.artifacts,
      checks: inputData.checks,
      judgments: inputData.judgments,
      questions: inputData.questions,
      nextSteps: inputData.nextSteps,
    });

    if (inputData.status !== 'planned') return passThrough();
    if (!inputData.taskPlan) throw new Error('plan stage did not provide a task plan for architect review');

    const architect = requiredAgent(mastra, 'architect');
    const planner = requiredAgent(mastra, 'planner');
    let taskPlan = inputData.taskPlan;
    const artifacts = [...inputData.artifacts];
    const checks = [...inputData.checks];
    const judgments = [...inputData.judgments];

    for (let attempt = 0; attempt <= inputData.maxRetries; attempt += 1) {
      const suffix = attempt === 0 ? 'initial' : `retry-${attempt}`;
      const reviewPath = attempt === 0 ? '.delivery/artifacts/review-report.json' : `.delivery/artifacts/review-report.${suffix}.json`;

      startDeliveryStage({
        repoPath: inputData.repoPath,
        stage: `review:${suffix}`,
        role: 'architect',
      });

      const reviewResponse = await architect.generate(
        `Review the task plan below for structural readiness before implementation.

Evaluate granularity, error handling, trust boundaries, state authority, fail-fast behavior, data flow, security, and complexity.
Approve only when build can safely begin. Block when planner changes are required before implementation.
Every finding must be specific, evidenced, and remediable by an owning role.

Task plan:
${JSON.stringify(taskPlan, null, 2)}`,
        {
          requestContext: new RequestContext([['repoPath', inputData.repoPath]]),
          structuredOutput: {
            schema: reviewReportSchema,
            model: deliveryModel,
            instructions: 'Return only a review-report object.',
          },
        },
      );

      const reviewReport = reviewReportSchema.parse(reviewResponse.object);
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: reviewPath,
        artifact: reviewReport,
      });
      recordDeliveryArtifact({
        repoPath: inputData.repoPath,
        type: attempt === 0 ? 'review-report' : `review-report:${suffix}`,
        path: reviewPath,
      });
      artifacts.push(reviewPath);

      endDeliveryStage({
        repoPath: inputData.repoPath,
        stage: `review:${suffix}`,
        reason: reviewReport.verdict === 'blocked' ? 'escalation' : 'complete_stage',
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
        };
      }

      if (!reviewJudge.judgment.passed) {
        return {
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Architect review report failed rubric judgment.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: reviewJudge.judgment.remediation,
        };
      }

      if (attempt >= inputData.maxRetries) {
        return {
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
        };
      }

      const revisionNumber = attempt + 1;
      startDeliveryStage({
        repoPath: inputData.repoPath,
        stage: `plan:architect-bounce-${revisionNumber}`,
        role: 'planner',
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
          requestContext: new RequestContext([['repoPath', inputData.repoPath]]),
          structuredOutput: {
            schema: plannerRevisionOutputSchema,
            model: deliveryModel,
            instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
          },
        },
      );

      const revision = plannerRevisionOutputSchema.parse(revisionResponse.object);
      taskPlan = revision.taskPlan;
      const revisionPath = `.delivery/artifacts/task-plan.revision-${revisionNumber}.json`;
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: revisionPath,
        artifact: taskPlan,
      });
      recordDeliveryArtifact({
        repoPath: inputData.repoPath,
        type: `task-plan:revision-${revisionNumber}`,
        path: revisionPath,
      });
      artifacts.push(revisionPath);

      endDeliveryStage({
        repoPath: inputData.repoPath,
        stage: `plan:architect-bounce-${revisionNumber}`,
        reason: 'complete_stage',
      });

      const revisedDeterministicResults = taskPlanDeterministicResults(taskPlan);
      checks.push(...checkSummaries(revisedDeterministicResults, `revision-${revisionNumber}`));
      const failedRevisedChecks = revisedDeterministicResults.filter((check) => !check.passed);
      if (failedRevisedChecks.length) {
        return {
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Planner revision failed deterministic task-plan gates.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: failedRevisedChecks.map((check) => check.reason ?? 'deterministic check failed'),
        };
      }

      const revisedPlanJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        rubricName: 'task-plan',
        subjectName: revisionPath,
        subject: taskPlan,
        deterministicResults: revisedDeterministicResults,
        slug: `task-plan-revision-${revisionNumber}`,
      });
      artifacts.push(revisedPlanJudge.judgeOutputPath, revisedPlanJudge.judgmentPath);
      judgments.push(revisedPlanJudge.ref);

      if (!revisedPlanJudge.judgment.passed) {
        return {
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Planner revision failed task-plan rubric judgment.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: revisedPlanJudge.judgment.remediation,
        };
      }
    }

    return {
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Architect review did not reach a terminal state.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Inspect .delivery/events.jsonl and rerun the review stage.'],
    };
  },
});

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description:
    'Native Delivery Engine workflow: initialize run state, create readout and task plan, judge plan quality, and run architect review.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(initializeRunStep)
  .then(createPlanStep)
  .then(createReviewStep)
  .commit();
