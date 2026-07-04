import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deliveryRoles } from './boundaries';
import { runDeterministicCheck } from './checks';
import { aggregateJudgment } from './judgment';
import {
  getDeliveryObservabilityStore,
  listDeliveryStateRecords,
  persistDeliveryJudgmentScoresWithMastra,
  persistDeliveryStateWithMastra,
} from './observability';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  finishDeliveryRunState,
  getDeliveryRunStatusState,
  initializeDeliveryRunState,
  readDeliveryEventsState,
  recordDeliveryArtifactState,
  recordDeliveryJudgmentState,
  startDeliveryStageState,
  updateDeliveryTaskState,
} from './state-service';
import { writeDeliveryArtifact } from './state';

const roleSchema = z.enum(deliveryRoles as [string, ...string[]]);

export const initializeDeliveryRunTool = createTool({
  id: 'initialize-delivery-run',
  description: 'Initialize delivery run state and project it into Mastra storage.',
  inputSchema: z.object({
    repoPath: z.string(),
    visionPath: z.string(),
    specPath: z.string(),
  }),
  outputSchema: z.object({
    run_id: z.string(),
    status: z.string(),
    stage: z.string(),
  }),
  execute: async (input, context) => initializeDeliveryRunState({ ...input, mastra: context?.mastra }),
});

export const startDeliveryStageTool = createTool({
  id: 'start-delivery-stage',
  description: 'Start a delivery stage and materialize the active role boundary manifest.',
  inputSchema: z.object({
    repoPath: z.string(),
    stage: z.string(),
    role: roleSchema,
    surfaces: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    boundary: z.any(),
  }),
  execute: async (input, context) => startDeliveryStageState({ ...input, mastra: context?.mastra }),
});

export const endDeliveryStageTool = createTool({
  id: 'end-delivery-stage',
  description: 'End a delivery stage and clear the active role boundary manifest.',
  inputSchema: z.object({
    repoPath: z.string(),
    stage: z.string(),
    reason: z.enum(['complete_stage', 'escalation', 'max_turns']),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, context) => endDeliveryStageState({ ...input, mastra: context?.mastra }),
});

export const updateDeliveryTaskTool = createTool({
  id: 'update-delivery-task',
  description: 'Update delivery task status and persist the current state to Mastra storage.',
  inputSchema: z.object({
    repoPath: z.string(),
    id: z.string(),
    status: z.enum(['pending', 'building', 'judging', 'complete', 'stuck', 'blocked']),
    owner: z.string().optional(),
    note: z.string().optional(),
    bumpRetries: z.boolean().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    task: z.any(),
  }),
  execute: async (input, context) => updateDeliveryTaskState({ ...input, mastra: context?.mastra }),
});

export const recordDeliveryArtifactTool = createTool({
  id: 'record-delivery-artifact',
  description: 'Register an exported artifact path and persist the current state to Mastra storage.',
  inputSchema: z.object({
    repoPath: z.string(),
    type: z.string(),
    path: z.string(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, context) => recordDeliveryArtifactState({ ...input, mastra: context?.mastra }),
});

export const writeDeliveryArtifactTool = createTool({
  id: 'write-delivery-artifact',
  description: 'Write a JSON artifact under the target repo and return its path.',
  inputSchema: z.object({
    repoPath: z.string(),
    artifactPath: z.string(),
    artifact: z.any(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
  }),
  execute: async (input) => writeDeliveryArtifact(input),
});

export const recordDeliveryJudgmentTool = createTool({
  id: 'record-delivery-judgment',
  description: 'Record a scored rubric judgment and persist it to Mastra storage and scores.',
  inputSchema: z.object({
    repoPath: z.string(),
    subject: z.string(),
    rubric: z.string(),
    path: z.string(),
    overall: z.number().optional(),
    passed: z.boolean().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input, context) => recordDeliveryJudgmentState({ ...input, mastra: context?.mastra }),
});

export const recordDeliveryEventTool = createTool({
  id: 'record-delivery-event',
  description: 'Append a delivery event and persist the current state to Mastra storage.',
  inputSchema: z.object({
    repoPath: z.string(),
    event: z.record(z.string(), z.any()),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ repoPath, event }, context) =>
    appendDeliveryEventState({ repoPath, event: event as any, mastra: context?.mastra }),
});

export const finishDeliveryRunTool = createTool({
  id: 'finish-delivery-run',
  description: 'Mark a delivery run complete, failed, or stuck.',
  inputSchema: z.object({
    repoPath: z.string(),
    status: z.enum(['running', 'complete', 'failed', 'stuck']),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    status: z.string(),
  }),
  execute: async (input, context) => finishDeliveryRunState({ ...input, mastra: context?.mastra }),
});

export const getDeliveryRunStatusTool = createTool({
  id: 'get-delivery-run-status',
  description: 'Read compact delivery run status from Mastra storage, falling back to the local .delivery projection.',
  inputSchema: z.object({
    repoPath: z.string(),
  }),
  outputSchema: z.object({
    run_id: z.string(),
    status: z.string(),
    stage: z.string(),
    tasks: z.array(z.string()),
    stuck: z.array(z.any()),
    judgments: z.number(),
    artifacts: z.array(z.string()),
  }),
  execute: async ({ repoPath }, context) => getDeliveryRunStatusState({ repoPath, mastra: context?.mastra }),
});

export const runDeterministicCheckTool = createTool({
  id: 'run-deterministic-check',
  description: 'Run a native deterministic delivery gate/check without asking a model to judge it.',
  inputSchema: z.object({
    repoPath: z.string().optional(),
    name: z.enum([
      'release_blockers_zero',
      'dependency_graph_acyclic',
      'plan_schema_complete',
      'tier_order',
      'no_bcrypt_weak_hash',
      'file_ownership',
      'write_paths_in_boundary',
      'ran_code_before_complete',
      'no_code_artifacts_written',
      'harness_run_before_findings',
      'release_gate_read_before_deploy',
      'live_verify_after_deploy',
      'ended_explicitly',
    ]),
    subject: z.any().optional(),
    events: z.array(z.record(z.string(), z.any())).optional(),
    role: roleSchema.optional(),
    stage: z.string().optional(),
    mode: z.enum(['coherence', 'deployable']).optional(),
    files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
    paths: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    reason: z.string(),
  }),
  execute: async ({ repoPath, events, ...input }, context) => {
    const resolvedEvents = events ?? (repoPath ? await readDeliveryEventsState({ repoPath, mastra: context?.mastra }) : undefined);
    return runDeterministicCheck({ ...input, events: resolvedEvents } as any);
  },
});

export const aggregateJudgmentTool = createTool({
  id: 'aggregate-judgment',
  description: 'Aggregate rubric gates, deterministic checks, and judge scores into a native delivery judgment.',
  inputSchema: z.object({
    rubric: z.any(),
    judgeOutput: z.any().optional(),
    deterministicResults: z
      .array(
        z.object({
          id: z.string().optional(),
          check: z.string().optional(),
          passed: z.boolean(),
          reason: z.string().optional(),
        }),
      )
      .default([]),
    threshold: z.number().min(0).max(1).default(0.7),
  }),
  outputSchema: z.any(),
  execute: async (input) => aggregateJudgment(input as Parameters<typeof aggregateJudgment>[0]),
});

const persistDeliveryStateInputSchema = z.object({
  repoPath: z.string(),
});

const deliveryScorePersistenceSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  judgmentCount: z.number(),
  scoresSubmitted: z.number(),
  scoresSkipped: z.number(),
  observabilityScoresSubmitted: z.number(),
});

const deliveryStatePersistenceOutputSchema = z.object({
  ok: z.boolean(),
  runId: z.string(),
  status: z.string(),
  stage: z.string(),
  eventCount: z.number(),
  logsSubmitted: z.number(),
});

const deliveryStateRecordListInputSchema = z.object({
  repoPath: z.string().optional(),
  runId: z.string().optional(),
  page: z.number().int().min(0).default(0),
  perPage: z.number().int().min(1).max(100).default(25),
});

async function persistDeliveryStateRecords(repoPath: string, mastra?: unknown) {
  const statePersistence = await persistDeliveryStateWithMastra({
    repoPath,
    mastra: mastra as Parameters<typeof persistDeliveryStateWithMastra>[0]['mastra'],
  });
  const scorePersistence = await persistDeliveryJudgmentScoresWithMastra({
    repoPath,
    mastra: mastra as Parameters<typeof persistDeliveryJudgmentScoresWithMastra>[0]['mastra'],
  });
  return { statePersistence, scorePersistence };
}

async function listDeliveryStateRecords(
  input: z.infer<typeof deliveryStateRecordListInputSchema>,
  mastra?: unknown,
) {
  const store = await getDeliveryObservabilityStore(
    mastra as Parameters<typeof getDeliveryObservabilityStore>[0],
  );
  if (!store) throw new Error('Mastra observability storage is not configured');
  return listDeliveryStateRecords({ store, ...input });
}

export const persistDeliveryStateTool = createTool({
  id: 'persist-delivery-state',
  description: 'Persist the current delivery run projection, events, and rubric judgments into Mastra storage.',
  inputSchema: persistDeliveryStateInputSchema,
  outputSchema: deliveryStatePersistenceOutputSchema.extend({
    scorePersistence: deliveryScorePersistenceSchema,
  }),
  execute: async ({ repoPath }, context) => {
    const { statePersistence, scorePersistence } = await persistDeliveryStateRecords(repoPath, context?.mastra);
    return { ...statePersistence, scorePersistence };
  },
});

export const listDeliveryStateRecordsTool = createTool({
  id: 'list-delivery-state-records',
  description: 'List native delivery state records from Mastra observability storage.',
  inputSchema: deliveryStateRecordListInputSchema,
  outputSchema: z.any(),
  execute: async (input, context) => listDeliveryStateRecords(input, context?.mastra),
});

export const mirrorDeliveryStateTool = createTool({
  id: 'mirror-delivery-state',
  description: 'Compatibility alias for persist-delivery-state.',
  inputSchema: persistDeliveryStateInputSchema,
  outputSchema: deliveryStatePersistenceOutputSchema.extend({
    scoreMirror: deliveryScorePersistenceSchema,
  }),
  execute: async ({ repoPath }, context) => {
    const { statePersistence, scorePersistence } = await persistDeliveryStateRecords(repoPath, context?.mastra);
    return { ...statePersistence, scoreMirror: scorePersistence };
  },
});

export const listDeliveryStateMirrorsTool = createTool({
  id: 'list-delivery-state-mirrors',
  description: 'Compatibility alias for list-delivery-state-records.',
  inputSchema: deliveryStateRecordListInputSchema,
  outputSchema: z.any(),
  execute: async (input, context) => listDeliveryStateRecords(input, context?.mastra),
});

export const deliveryStateTools = {
  initializeDeliveryRunTool,
  startDeliveryStageTool,
  endDeliveryStageTool,
  updateDeliveryTaskTool,
  recordDeliveryArtifactTool,
  writeDeliveryArtifactTool,
  recordDeliveryJudgmentTool,
  recordDeliveryEventTool,
  finishDeliveryRunTool,
  getDeliveryRunStatusTool,
  runDeterministicCheckTool,
  aggregateJudgmentTool,
  persistDeliveryStateTool,
  listDeliveryStateRecordsTool,
  mirrorDeliveryStateTool,
  listDeliveryStateMirrorsTool,
};
