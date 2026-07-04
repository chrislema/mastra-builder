import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  endDeliveryStage,
  initializeDeliveryRun,
  recordDeliveryArtifact,
  startDeliveryStage,
  writeDeliveryArtifact,
} from './state';
import { dependencyGraphAcyclic, planSchemaComplete } from './checks';

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

const plannerOutputSchema = z.object({
  readout: readoutSchema,
  taskPlan: taskPlanSchema,
});

const initializedSchema = workflowInputSchema.extend({
  runId: z.string(),
});

const workflowOutputSchema = z.object({
  status: z.enum(['planned', 'blocked_on_questions', 'stuck']),
  runId: z.string(),
  summary: z.string(),
  artifacts: z.array(z.string()),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), reason: z.string() })),
  questions: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()),
});

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
  outputSchema: workflowOutputSchema,
  execute: async ({ inputData, mastra }) => {
    startDeliveryStage({
      repoPath: inputData.repoPath,
      stage: 'plan',
      role: 'planner',
    });

    const planner = mastra?.getAgentById('planner');
    if (!planner) throw new Error('planner agent is not registered');

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

    const output = response.object;
    if (!output) throw new Error('planner did not return structured output');

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

    const checks = [
      { check: 'plan_schema_complete', ...planSchemaComplete(output.taskPlan) },
      { check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(output.taskPlan) },
    ];

    if (output.readout.blocking_ambiguities.length) {
      return {
        status: 'blocked_on_questions' as const,
        runId: inputData.runId,
        summary: output.readout.recommended_next_step,
        artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
        checks,
        questions: output.readout.blocking_ambiguities,
        nextSteps: ['Answer the blocking questions, then rerun or resume delivery planning.'],
      };
    }

    if (checks.some((check) => !check.passed)) {
      return {
        status: 'stuck' as const,
        runId: inputData.runId,
        summary: 'Planner produced artifacts, but deterministic plan checks failed.',
        artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
        checks,
        questions: [],
        nextSteps: checks.filter((check) => !check.passed).map((check) => check.reason),
      };
    }

    return {
      status: 'planned' as const,
      runId: inputData.runId,
      summary: output.taskPlan.scope,
      artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
      checks,
      questions: [],
      nextSteps: [
        'Run architecture review against .delivery/artifacts/task-plan.json.',
        'Wire the review/build/test/deploy stages into this native workflow next.',
      ],
    };
  },
});

export const deliveryWorkflow = createWorkflow({
  id: 'delivery-workflow',
  description: 'Native Delivery Engine workflow: initialize run state, create readout and task plan, and run plan gates.',
  inputSchema: workflowInputSchema,
  outputSchema: workflowOutputSchema,
})
  .then(initializeRunStep)
  .then(createPlanStep)
  .commit();
