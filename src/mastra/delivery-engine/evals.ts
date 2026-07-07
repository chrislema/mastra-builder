import type { Dataset } from '@mastra/core/datasets';
import type { Mastra } from '@mastra/core/mastra';
import { z } from 'zod';

export const deliveryRegressionDatasetName = 'delivery-scorecard-regression';
export const deliveryRegressionSuiteVersion = 2;

export const deliveryRegressionScorerIds = [
  'delivery-workflow-completion',
  'delivery-rubric-floor',
  'delivery-judgment-pass-rate',
  'delivery-deterministic-checks',
  'delivery-acceptance-contract-coverage',
  'delivery-plan-to-architect-handoff',
  'delivery-architect-to-build-handoff',
  'delivery-build-to-tester-handoff',
  'delivery-tester-to-deployer-handoff',
] as const;

export type DeliveryRegressionScorerId = (typeof deliveryRegressionScorerIds)[number];

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
  { check: 'acceptance_criteria_contracts', passed: true, reason: 'ok' },
];

const expectedScores = (overrides: Partial<Record<DeliveryRegressionScorerId, number>>) =>
  Object.fromEntries(deliveryRegressionScorerIds.map((scorerId) => [scorerId, overrides[scorerId] ?? 0])) as Record<
    DeliveryRegressionScorerId,
    number
  >;

export const deliveryRegressionDatasetItems: DeliveryRegressionDatasetItem[] = [
  {
    metadata: { caseId: 'planner-ready-handoff', stage: 'planning' },
    input: {
      status: 'planned',
      runId: 'run-planned',
      summary: 'Planner produced an executable task plan.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      checks: passingChecks,
      judgments: [passingJudgments[0]],
      nextSteps: ['review plan'],
    },
    groundTruth: {
      caseId: 'planner-ready-handoff',
      expectedScores: expectedScores({
        'delivery-plan-to-architect-handoff': 1,
        'delivery-rubric-floor': 0.92,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
        'delivery-acceptance-contract-coverage': 1,
      }),
      rationale: 'A planned run should hand off to architect review, not later stages.',
    },
  },
  {
    metadata: { caseId: 'architect-ready-handoff', stage: 'review' },
    input: {
      status: 'reviewed',
      runId: 'run-reviewed',
      summary: 'Architect approved the task plan for build.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      checks: passingChecks,
      judgments: [passingJudgments[0]],
      nextSteps: ['build task-1'],
    },
    groundTruth: {
      caseId: 'architect-ready-handoff',
      expectedScores: expectedScores({
        'delivery-architect-to-build-handoff': 1,
        'delivery-rubric-floor': 0.92,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
        'delivery-acceptance-contract-coverage': 1,
      }),
      rationale: 'A reviewed run should hand off to engineer/designer build work.',
    },
  },
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
      expectedScores: expectedScores({
        'delivery-workflow-completion': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
        'delivery-acceptance-contract-coverage': 1,
      }),
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
      expectedScores: expectedScores({
        'delivery-workflow-completion': 0,
        'delivery-tester-to-deployer-handoff': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
        'delivery-acceptance-contract-coverage': 1,
      }),
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
      expectedScores: expectedScores({
        'delivery-workflow-completion': 0,
        'delivery-build-to-tester-handoff': 1,
        'delivery-rubric-floor': 0.84,
        'delivery-judgment-pass-rate': 1,
        'delivery-deterministic-checks': 1,
        'delivery-acceptance-contract-coverage': 1,
      }),
      rationale: 'A built run should hand off to tester, not claim deployment completion.',
    },
  },
  {
    metadata: { caseId: 'release-gate-failed', stage: 'release-gate' },
    input: {
      status: 'gate_failed',
      runId: 'run-release-gate-failed',
      summary: 'Tester blocked release on failed local evidence.',
      taskPlan: { tasks: [{ id: 'task-1' }] },
      releaseGate: { decision: 'fail', blockers: ['local smoke check failed'] },
      checks: [
        { check: 'plan_schema_complete', passed: true, reason: 'ok' },
        { check: 'runtime_probe_passed', passed: false, reason: 'health route failed' },
      ],
      judgments: [
        passingJudgments[0],
        {
          subject: '.delivery/artifacts/release-gate.json',
          rubric: 'release-gate',
          path: '.delivery/artifacts/judgments/release-gate.judgment.json',
          overall: 0.55,
          passed: false,
        },
      ],
      nextSteps: ['repair release gate blockers'],
    },
    groundTruth: {
      caseId: 'release-gate-failed',
      expectedScores: expectedScores({
        'delivery-rubric-floor': 0.55,
        'delivery-judgment-pass-rate': 0.5,
        'delivery-deterministic-checks': 0.5,
      }),
      rationale: 'A failed release gate should preserve failed evidence without handing off to deployment.',
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
      expectedScores: expectedScores({
        'delivery-workflow-completion': 0,
        'delivery-rubric-floor': 0.4,
        'delivery-judgment-pass-rate': 0.5,
        'delivery-deterministic-checks': 0.5,
      }),
      rationale: 'A stuck run should preserve the rubric floor and failed evidence rates.',
    },
  },
  {
    metadata: { caseId: 'blocked-on-planner-questions', stage: 'planning' },
    input: {
      status: 'blocked_on_questions',
      runId: 'run-blocked-on-questions',
      summary: 'Planner needs a source-document decision before work can proceed.',
      checks: [],
      judgments: [],
      nextSteps: ['answer planner questions'],
    },
    groundTruth: {
      caseId: 'blocked-on-planner-questions',
      expectedScores: expectedScores({}),
      rationale: 'A human-input pause is not a failed build, but no delivery handoff or quality score is ready yet.',
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

export type DeliveryRegressionVerdict = 'passed' | 'scored' | 'failed';

export type DeliveryRegressionGateResult = {
  id: string;
  passed: boolean;
  score: number;
  reason: string;
};

export type DeliveryRegressionThreshold = number | { min?: number; max?: number };

export type DeliveryRegressionThresholdResult = {
  id: string;
  passed: boolean;
  averageScore: number;
  threshold: DeliveryRegressionThreshold;
  reason: string;
};

export type DeliveryRegressionScorerCoverage = {
  scorerId: string;
  expectedItems: number;
  scoredItems: number;
  positiveExamples: number;
  negativeExamples: number;
  missingScoreCaseIds: string[];
};

export type DeliveryRegressionCoverageReport = {
  totalScorers: number;
  coveredScorers: number;
  missingScorers: string[];
  totalExpectations: number;
  scorerCoverage: DeliveryRegressionScorerCoverage[];
};

export type DeliveryRegressionGateThresholds = {
  minTotalItems: number;
  minSucceededRate: number;
  maxFailedItems: number;
  maxMismatches: number;
  maxPersistenceFailures: number;
  minScorerCoverageRate: number;
  minScoreAlignmentRate: number;
};

export type DeliveryRegressionGateReport = {
  generatedAt: string;
  suiteVersion: number;
  datasetId: string;
  experimentId: string;
  status: string;
  totalItems: number;
  succeededCount: number;
  failedCount: number;
  succeededRate: number;
  persistenceFailures: number;
  scorerAverages: Record<string, number>;
  coverage: DeliveryRegressionCoverageReport;
  thresholds: DeliveryRegressionGateThresholds;
  gateResults: DeliveryRegressionGateResult[];
  thresholdResults: DeliveryRegressionThresholdResult[];
  verdict: DeliveryRegressionVerdict;
  mismatches: DeliveryRegressionScoreMismatch[];
  gate: {
    passed: boolean;
    reasons: string[];
  };
  trend?: {
    previousExperimentId?: string;
    mismatchDelta?: number;
    succeededRateDelta?: number;
    scorerAverageDelta: Record<string, number>;
  };
};

export const deliveryRegressionGateThresholds: DeliveryRegressionGateThresholds = {
  minTotalItems: deliveryRegressionDatasetItems.length,
  minSucceededRate: 1,
  maxFailedItems: 0,
  maxMismatches: 0,
  maxPersistenceFailures: 0,
  minScorerCoverageRate: 1,
  minScoreAlignmentRate: 1,
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
        metadata: {
          suite: 'delivery-engine',
          kind: 'scorecard-regression',
          suiteVersion: deliveryRegressionSuiteVersion,
          scorerIds: [...deliveryRegressionScorerIds],
        },
      });

  if (existingRecord) {
    await dataset.update({
      description: 'Regression dataset for delivery scorecards and stage handoff contracts.',
      inputSchema: deliveryScorecardInputSchema,
      groundTruthSchema: deliveryScoreExpectationSchema,
      targetType: 'scorer',
      targetIds: [...deliveryRegressionScorerIds],
      scorerIds: [...deliveryRegressionScorerIds],
      metadata: {
        suite: 'delivery-engine',
        kind: 'scorecard-regression',
        suiteVersion: deliveryRegressionSuiteVersion,
        scorerIds: [...deliveryRegressionScorerIds],
      },
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

const rounded = (score: number) => Math.round(score * 1000) / 1000;

function thresholdPassed(value: number, threshold: DeliveryRegressionThreshold) {
  if (typeof threshold === 'number') return value >= threshold;
  if (typeof threshold.min === 'number' && value < threshold.min) return false;
  if (typeof threshold.max === 'number' && value > threshold.max) return false;
  return true;
}

function thresholdReason(id: string, value: number, threshold: DeliveryRegressionThreshold) {
  if (typeof threshold === 'number') return `${id} ${value} must be at least ${threshold}.`;
  const parts = [];
  if (typeof threshold.min === 'number') parts.push(`at least ${threshold.min}`);
  if (typeof threshold.max === 'number') parts.push(`at most ${threshold.max}`);
  return `${id} ${value} must be ${parts.join(' and ')}.`;
}

export function buildDeliveryRegressionCoverageReport(
  summary: Pick<DeliveryExperimentSummary, 'results'>,
): DeliveryRegressionCoverageReport {
  const scorerCoverage = deliveryRegressionScorerIds.map((scorerId) => {
    let expectedItems = 0;
    let scoredItems = 0;
    let positiveExamples = 0;
    let negativeExamples = 0;
    const missingScoreCaseIds: string[] = [];

    for (const result of summary.results) {
      const groundTruth = deliveryScoreExpectationSchema.safeParse(result.groundTruth);
      if (!groundTruth.success) continue;

      const expected = groundTruth.data.expectedScores[scorerId];
      if (typeof expected !== 'number') continue;

      expectedItems += 1;
      if (expected > 0) positiveExamples += 1;
      else negativeExamples += 1;

      const score = result.scores.find((candidate) => candidate.scorerId === scorerId);
      if (typeof score?.score === 'number') scoredItems += 1;
      else missingScoreCaseIds.push(groundTruth.data.caseId);
    }

    return {
      scorerId,
      expectedItems,
      scoredItems,
      positiveExamples,
      negativeExamples,
      missingScoreCaseIds,
    };
  });

  const missingScorers = scorerCoverage
    .filter((coverage) => coverage.expectedItems === 0 || coverage.positiveExamples === 0 || coverage.negativeExamples === 0)
    .map((coverage) => coverage.scorerId);

  return {
    totalScorers: deliveryRegressionScorerIds.length,
    coveredScorers: deliveryRegressionScorerIds.length - missingScorers.length,
    missingScorers,
    totalExpectations: scorerCoverage.reduce((sum, coverage) => sum + coverage.expectedItems, 0),
    scorerCoverage,
  };
}

function buildGateResult({ id, passed, reason }: { id: string; passed: boolean; reason: string }): DeliveryRegressionGateResult {
  return {
    id,
    passed,
    score: passed ? 1 : 0,
    reason,
  };
}

function buildThresholdResult({
  id,
  averageScore,
  threshold,
}: {
  id: string;
  averageScore: number;
  threshold: DeliveryRegressionThreshold;
}): DeliveryRegressionThresholdResult {
  const passed = thresholdPassed(averageScore, threshold);
  return {
    id,
    passed,
    averageScore,
    threshold,
    reason: passed ? `${id} ${averageScore} satisfies threshold.` : thresholdReason(id, averageScore, threshold),
  };
}

function scorerAverages(summary: DeliveryExperimentSummary) {
  const byScorer = new Map<string, number[]>();
  for (const result of summary.results) {
    for (const score of result.scores) {
      if (typeof score.score !== 'number') continue;
      const scores = byScorer.get(score.scorerId) ?? [];
      scores.push(score.score);
      byScorer.set(score.scorerId, scores);
    }
  }

  return Object.fromEntries(
    [...byScorer.entries()].map(([scorerId, scores]) => [
      scorerId,
      rounded(scores.reduce((sum, score) => sum + score, 0) / scores.length),
    ]),
  );
}

export function buildDeliveryRegressionGateReport({
  datasetId,
  summary,
  mismatches,
  thresholds = deliveryRegressionGateThresholds,
  previousReport,
}: {
  datasetId: string;
  summary: DeliveryExperimentSummary;
  mismatches: DeliveryRegressionScoreMismatch[];
  thresholds?: DeliveryRegressionGateThresholds;
  previousReport?: DeliveryRegressionGateReport;
}): DeliveryRegressionGateReport {
  const succeededRate = summary.totalItems ? rounded(summary.succeededCount / summary.totalItems) : 0;
  const persistenceFailures = summary.persistenceFailures ?? 0;
  const coverage = buildDeliveryRegressionCoverageReport(summary);
  const scorerCoverageRate = coverage.totalScorers ? rounded(coverage.coveredScorers / coverage.totalScorers) : 0;
  const scoreAlignmentRate = coverage.totalExpectations
    ? rounded((coverage.totalExpectations - mismatches.length) / coverage.totalExpectations)
    : 0;

  const gateResults: DeliveryRegressionGateResult[] = [
    buildGateResult({
      id: 'experiment-completed',
      passed: summary.status === 'completed',
      reason: `Experiment status is ${summary.status}, expected completed.`,
    }),
    buildGateResult({
      id: 'minimum-dataset-size',
      passed: summary.totalItems >= thresholds.minTotalItems,
      reason: `Experiment ran ${summary.totalItems} item(s), expected at least ${thresholds.minTotalItems}.`,
    }),
    buildGateResult({
      id: 'failed-items',
      passed: summary.failedCount <= thresholds.maxFailedItems,
      reason: `Experiment had ${summary.failedCount} failed item(s), allowed ${thresholds.maxFailedItems}.`,
    }),
    buildGateResult({
      id: 'persistence-failures',
      passed: persistenceFailures <= thresholds.maxPersistenceFailures,
      reason: `Experiment had ${persistenceFailures} persistence failure(s), allowed ${thresholds.maxPersistenceFailures}.`,
    }),
    buildGateResult({
      id: 'score-mismatches',
      passed: mismatches.length <= thresholds.maxMismatches,
      reason: `Experiment had ${mismatches.length} score mismatch(es), allowed ${thresholds.maxMismatches}.`,
    }),
    buildGateResult({
      id: 'scorer-coverage',
      passed: coverage.missingScorers.length === 0,
      reason: coverage.missingScorers.length
        ? `Missing positive/negative coverage for scorer(s): ${coverage.missingScorers.join(', ')}.`
        : 'Every delivery scorer has positive and negative regression coverage.',
    }),
  ];

  const thresholdResults: DeliveryRegressionThresholdResult[] = [
    buildThresholdResult({
      id: 'succeeded-rate',
      averageScore: succeededRate,
      threshold: { min: thresholds.minSucceededRate },
    }),
    buildThresholdResult({
      id: 'scorer-coverage-rate',
      averageScore: scorerCoverageRate,
      threshold: { min: thresholds.minScorerCoverageRate },
    }),
    buildThresholdResult({
      id: 'score-alignment-rate',
      averageScore: scoreAlignmentRate,
      threshold: { min: thresholds.minScoreAlignmentRate },
    }),
  ];

  const verdict: DeliveryRegressionVerdict = gateResults.some((result) => !result.passed)
    ? 'failed'
    : thresholdResults.some((result) => !result.passed)
      ? 'scored'
      : 'passed';
  const reasons = [
    ...gateResults.filter((result) => !result.passed).map((result) => result.reason),
    ...thresholdResults.filter((result) => !result.passed).map((result) => result.reason),
  ];

  const currentAverages = scorerAverages(summary);
  const report: DeliveryRegressionGateReport = {
    generatedAt: new Date().toISOString(),
    suiteVersion: deliveryRegressionSuiteVersion,
    datasetId,
    experimentId: summary.experimentId,
    status: summary.status,
    totalItems: summary.totalItems,
    succeededCount: summary.succeededCount,
    failedCount: summary.failedCount,
    succeededRate,
    persistenceFailures,
    scorerAverages: currentAverages,
    coverage,
    thresholds,
    gateResults,
    thresholdResults,
    verdict,
    mismatches,
    gate: {
      passed: verdict === 'passed',
      reasons,
    },
  };

  if (previousReport) {
    report.trend = {
      previousExperimentId: previousReport.experimentId,
      mismatchDelta: mismatches.length - previousReport.mismatches.length,
      succeededRateDelta: rounded(succeededRate - previousReport.succeededRate),
      scorerAverageDelta: Object.fromEntries(
        Object.entries(currentAverages).map(([scorerId, average]) => [
          scorerId,
          rounded(average - (previousReport.scorerAverages[scorerId] ?? 0)),
        ]),
      ),
    };
  }

  return report;
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
      suiteVersion: deliveryRegressionSuiteVersion,
      scorerIds: [...deliveryRegressionScorerIds],
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
