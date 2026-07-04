import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deliveryRoles } from './boundaries';
import { runDeterministicCheck } from './checks';
import { aggregateJudgment } from './judgment';
import {
  appendDeliveryEvent,
  endDeliveryStage,
  finishDeliveryRun,
  getDeliveryRunStatus,
  initializeDeliveryRun,
  readDeliveryEvents,
  recordDeliveryArtifact,
  recordDeliveryJudgment,
  startDeliveryStage,
  updateDeliveryTask,
  writeDeliveryArtifact,
} from './state';

const roleSchema = z.enum(deliveryRoles as [string, ...string[]]);

export const initializeDeliveryRunTool = createTool({
  id: 'initialize-delivery-run',
  description: 'Initialize authoritative .delivery run state for a target repo.',
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
  execute: async (input) => initializeDeliveryRun(input),
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
  execute: async (input) => startDeliveryStage(input as Parameters<typeof startDeliveryStage>[0]),
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
  execute: async (input) => endDeliveryStage(input),
});

export const updateDeliveryTaskTool = createTool({
  id: 'update-delivery-task',
  description: 'Update the authoritative task status inside .delivery/run.json.',
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
  execute: async (input) => updateDeliveryTask(input),
});

export const recordDeliveryArtifactTool = createTool({
  id: 'record-delivery-artifact',
  description: 'Register an artifact path in .delivery/run.json and append an artifact_write event.',
  inputSchema: z.object({
    repoPath: z.string(),
    type: z.string(),
    path: z.string(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => recordDeliveryArtifact(input),
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
  description: 'Record a scored rubric judgment in .delivery/run.json.',
  inputSchema: z.object({
    repoPath: z.string(),
    subject: z.string(),
    rubric: z.string(),
    path: z.string(),
    overall: z.number().optional(),
    passed: z.boolean().optional(),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async (input) => recordDeliveryJudgment(input),
});

export const recordDeliveryEventTool = createTool({
  id: 'record-delivery-event',
  description: 'Append a delivery event to .delivery/events.jsonl.',
  inputSchema: z.object({
    repoPath: z.string(),
    event: z.record(z.string(), z.any()),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ repoPath, event }) => {
    appendDeliveryEvent(repoPath, event as any);
    return { ok: true };
  },
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
  execute: async (input) => finishDeliveryRun(input),
});

export const getDeliveryRunStatusTool = createTool({
  id: 'get-delivery-run-status',
  description: 'Read .delivery/run.json and return a compact status summary.',
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
  execute: async ({ repoPath }) => getDeliveryRunStatus(repoPath),
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
  execute: async ({ repoPath, events, ...input }) => {
    const resolvedEvents = events ?? (repoPath ? readDeliveryEvents(repoPath) : undefined);
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
};
