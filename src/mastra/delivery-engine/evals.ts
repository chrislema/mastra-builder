import type { Dataset } from '@mastra/core/datasets';
import type { Mastra } from '@mastra/core/mastra';
import { z } from 'zod';

export const deliveryRegressionDatasetName = 'delivery-scorecard-regression';

export const deliveryRegressionScorerIds = [
  'delivery-workflow-completion',
  'delivery-rubric-floor',
  'delivery-judgment-pass-rate',
  'delivery-deterministic-checks',
  'delivery-plan-to-architect-handoff',
  'delivery-architect-to-build-handoff',
  'delivery-build-to-tester-handoff',
  'delivery-tester-to-deployer-handoff',
] as const;

const deliveryScorecardInputSchema = z.object({
  status: z.enum([
    'planned',
    'reviewed',
    'built',
    'release_ready',
    'gate_failed',
    'complete',
    'failed',
    'blocked_on_questions',
    'stuck',
  ]),
  runId: z.string(),
  summary: z.string(),
  taskPlan: z.object({ tasks: z.array(z.unknown()).optional() }).optional(),
  releaseGate: z
    .object({
      decision: z.string().optional(),
      blockers: z.array(z.string()).optional(),
    })
    .optional(),
  checks: z.array(z.object({ check: z.string(), passed: z.boolean(), reason: z.string() })).default([]),
  judgments: z
    .array(
      z.object({
        subject: z.string(),
        rubric: z.string(),
        path: z.string(),
        overall: z.number(),
        passed: z.boolean(),
      }),
    )
    .default([]),
  nextSteps: z.array(z.string()).default([]),
});

const deliveryScoreExpectationSchema = z.object({
  caseId: z.string(),
  expectedScores: z.record(z.string(), z.number()),
  rationale: z.string(),
});

type DeliveryScorecardInput = z.infer<typeof deliveryScorecardInputSchema>;
type DeliveryScoreExpectation = z.infer<typeof deliveryScoreExpectationSchema>;
type DeliveryRegressionDatasetItem = {
  input: DeliveryScorecardInput;
  groundTruth: DeliveryScoreExpectation;
  metadata: {
    caseId: string;
    stage: string;
  };
};
type DeliveryExperimentSummary = Awaited<ReturnType<Dataset['startExperiment']>>;

const passingJudgments = [
  {
    subject: '.delivery/artifacts/task-plan.json',
    rubric: 'task-plan',
    path: '.delivery/artifacts/judgments/task-plan.judgment.json',
    overall: 0.92,
    passed: true,
  },
  {
    subject: '.delivery/artifacts/release-gate.json',
    rubric: 'release-gate',
    path: '.delivery/artifacts/judgments/release-gate.judgment.json',
    overall: 0.84,
    passed: true,
  },
];

const passingChecks = [
  { check: 'plan_schema_complete', passed: true, reason: 'ok' },
  { check: 'tier_order', passed: true, reason: 'ok' },
];

export const deliveryRegressionDatasetItems: DeliveryRegressionDatasetItem[] = [
  {
    metadata: { caseId: 'complete-delivery', stage: 'deployment' },
    input: {
      status: 'complete',
      runId: 'run-complete',
      summary: 'Deployment complete.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      releaseGate: { decision: 'pass', blockers: [] },
      checks: passingChecks,
      judgments: passingJudgments,
      nextSteps: ['monitor'],
    },
    groundTruth: {
      caseId: 'complete-delivery',
      expectedScores: {
        'delivery-workflow-completion': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
      },
      rationale: 'A completed delivery with passing checks and judgments should score cleanly.',
    },
  },
  {
    metadata: { caseId: 'tester-ready-handoff', stage: 'release-gate' },
    input: {
      status: 'release_ready',
      runId: 'run-release-ready',
      summary: 'Release gate passed.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      releaseGate: { decision: 'pass', blockers: [] },
      checks: passingChecks,
      judgments: passingJudgments,
      nextSteps: ['deploy'],
    },
    groundTruth: {
      caseId: 'tester-ready-handoff',
      expectedScores: {
        'delivery-workflow-completion': 0,
        'delivery-tester-to-deployer-handoff': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
      },
      rationale: 'A release-ready run is deployable but not yet workflow-complete.',
    },
  },
  {
    metadata: { caseId: 'build-ready-handoff', stage: 'build' },
    input: {
      status: 'built',
      runId: 'run-built',
      summary: 'Build loop completed.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      checks: passingChecks,
      judgments: passingJudgments,
      nextSteps: ['test'],
    },
    groundTruth: {
      caseId: 'build-ready-handoff',
      expectedScores: {
        'delivery-workflow-completion': 0,
        'delivery-build-to-tester-handoff': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
      },
      rationale: 'A built run should hand off to tester, not claim deployment completion.',
    },
  },
  {
    metadata: { caseId: 'stuck-with-failed-evidence', stage: 'judgment' },
    input: {
      status: 'stuck',
      runId: 'run-stuck',
      summary: 'Implementation failed judgment.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      checks: [
        { check: 'plan_schema_complete', passed: true, reason: 'ok' },
        { check: 'tier_order', passed: false, reason: 'tier skipped' },
      ],
      judgments: [
        passingJudgments[0],
        {
          subject: '.delivery/artifacts/note-task-1.json',
          rubric: 'implementation',
          path: '.delivery/artifacts/judgments/implementation-task-1.judgment.json',
          overall: 0.4,
          passed: false,
        },
      ],
      nextSteps: ['fix implementation findings'],
    },
    groundTruth: {
      caseId: 'stuck-with-failed-evidence',
      expectedScores: {
        'delivery-workflow-completion': 0,
        'delivery-rubric-floor': 0.4,
        'delivery-judgment-pass-rate': 0.5,
        'delivery-deterministic-checks': 0.5,
      },
      rationale: 'A stuck run should preserve the rubric floor and failed evidence rates.',
    },
  },
];

export type DeliveryRegressionScoreMismatch = {
  itemId: string;
  caseId: string;
  scorerId: string;
  expected: number;
  actual: number | null;
  reason?: string | null;
};

function datasetItemsFromListResult(result: Awaited<ReturnType<Dataset['listItems']>>) {
  return Array.isArray(result) ? result : result.items;
}

export async function ensureDeliveryRegressionDataset(mastra: Mastra) {
  const existing = await mastra.datasets.list({
    filters: {
      name: deliveryRegressionDatasetName,
      targetType: 'scorer',
      targetIds: [...deliveryRegressionScorerIds],
    },
    perPage: 20,
  });
  const existingRecord = existing.datasets.find((dataset) => dataset.name === deliveryRegressionDatasetName);
  const dataset = existingRecord
    ? await mastra.datasets.get({ id: existingRecord.id })
    : await mastra.datasets.create({
        name: deliveryRegressionDatasetName,
        description: 'Regression dataset for delivery scorecards and stage handoff contracts.',
        inputSchema: deliveryScorecardInputSchema,
        groundTruthSchema: deliveryScoreExpectationSchema,
        targetType: 'scorer',
        targetIds: [...deliveryRegressionScorerIds],
        scorerIds: [...deliveryRegressionScorerIds],
        metadata: { suite: 'delivery-engine', kind: 'scorecard-regression' },
      });

  if (existingRecord) {
    await dataset.update({
      description: 'Regression dataset for delivery scorecards and stage handoff contracts.',
      inputSchema: deliveryScorecardInputSchema,
      groundTruthSchema: deliveryScoreExpectationSchema,
      targetType: 'scorer',
      targetIds: [...deliveryRegressionScorerIds],
      scorerIds: [...deliveryRegressionScorerIds],
      metadata: { suite: 'delivery-engine', kind: 'scorecard-regression' },
    });
  }

  const listedItems = datasetItemsFromListResult(await dataset.listItems({ page: 0, perPage: 100 }));
  const existingByCaseId = new Map(
    listedItems
      .map((item) => [typeof item.metadata?.caseId === 'string' ? item.metadata.caseId : undefined, item] as const)
      .filter((entry): entry is readonly [string, (typeof listedItems)[number]] => Boolean(entry[0])),
  );

  for (const item of deliveryRegressionDatasetItems) {
    const existingItem = existingByCaseId.get(item.metadata.caseId);
    if (existingItem) {
      await dataset.updateItem({ itemId: existingItem.id, ...item });
    } else {
      await dataset.addItem(item);
    }
  }

  return dataset;
}

export function collectDeliveryRegressionScoreMismatches(
  summary: DeliveryExperimentSummary,
  tolerance = 0.001,
): DeliveryRegressionScoreMismatch[] {
  return summary.results.flatMap((result) => {
    const groundTruth = deliveryScoreExpectationSchema.safeParse(result.groundTruth);
    if (!groundTruth.success) return [];

    return Object.entries(groundTruth.data.expectedScores).flatMap(([scorerId, expected]) => {
      const score = result.scores.find((candidate) => candidate.scorerId === scorerId);
      const actual = score?.score ?? null;
      if (actual !== null && Math.abs(actual - expected) <= tolerance) return [];

      return [
        {
          itemId: result.itemId,
          caseId: groundTruth.data.caseId,
          scorerId,
          expected,
          actual,
          reason: score?.reason,
        },
      ];
    });
  });
}

export async function runDeliveryRegressionExperiment(
  mastra: Mastra,
  options: {
    name?: string;
    description?: string;
    maxConcurrency?: number;
    itemTimeout?: number;
    failOnMismatch?: boolean;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const dataset = await ensureDeliveryRegressionDataset(mastra);
  const summary = await dataset.startExperiment({
    name: options.name ?? `delivery-scorecard-regression-${new Date().toISOString()}`,
    description: options.description ?? 'Delivery scorecard regression experiment.',
    task: ({ input }) => input,
    scorers: [...deliveryRegressionScorerIds],
    maxConcurrency: options.maxConcurrency ?? 4,
    itemTimeout: options.itemTimeout ?? 10_000,
    metadata: {
      suite: 'delivery-engine',
      kind: 'scorecard-regression',
      ...options.metadata,
    },
  });
  const mismatches = collectDeliveryRegressionScoreMismatches(summary);

  if (options.failOnMismatch !== false && mismatches.length) {
    throw new Error(
      `Delivery regression experiment found ${mismatches.length} score mismatch(es): ${mismatches
        .map((mismatch) => `${mismatch.caseId}/${mismatch.scorerId} expected ${mismatch.expected}, got ${mismatch.actual}`)
        .join('; ')}`,
    );
  }

  return { dataset, summary, mismatches };
}
