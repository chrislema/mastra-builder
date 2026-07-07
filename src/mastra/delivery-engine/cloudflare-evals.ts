import type { Dataset } from '@mastra/core/datasets';
import type { Mastra } from '@mastra/core/mastra';
import { z } from 'zod';

export const cloudflareArchitectureDatasetName = 'cloudflare-architecture-regression';
export const cloudflareArchitectureSuiteVersion = 1;

export const cloudflareArchitectureScorerIds = [
  'cloudflare-worker-first-topology',
  'cloudflare-storage-fit',
  'cloudflare-bindings-hygiene',
  'cloudflare-task-sequencing',
  'cloudflare-deployment-hygiene',
] as const;

export type CloudflareArchitectureScorerId = (typeof cloudflareArchitectureScorerIds)[number];

const cloudflareArchitectureOutputSchema = z.object({
  topology: z.string(),
  pagesExceptionEvidence: z.string().optional(),
  components: z.array(z.string()).default([]),
  bindings: z.array(z.string()).default([]),
  taskOrder: z.array(z.string()).default([]),
  deployment: z.array(z.string()).default([]),
  rationale: z.string().optional(),
  risks: z.array(z.string()).default([]),
});

const cloudflareArchitectureInputSchema = z.object({
  caseId: z.string(),
  vision: z.string(),
  spec: z.string(),
  candidate: cloudflareArchitectureOutputSchema,
});

const cloudflareArchitectureExpectationSchema = z.object({
  caseId: z.string(),
  expectedScores: z.record(z.string(), z.number()),
  expectedTopology: z.string(),
  requiredPagesExceptionEvidence: z.boolean().optional(),
  requiredComponents: z.array(z.string()).default([]),
  forbiddenComponents: z.array(z.string()).default([]),
  requiredBindings: z.array(z.string()).default([]),
  forbiddenBindings: z.array(z.string()).default([]),
  requiredTaskOrder: z.array(z.string()).default([]),
  requiredDeploymentSignals: z.array(z.string()).default([]),
  forbiddenDeploymentSignals: z.array(z.string()).default([]),
  rationale: z.string(),
});

type CloudflareArchitectureInput = z.input<typeof cloudflareArchitectureInputSchema>;
type CloudflareArchitectureExpectation = z.input<typeof cloudflareArchitectureExpectationSchema>;
type CloudflareArchitectureDatasetItem = {
  input: CloudflareArchitectureInput;
  groundTruth: CloudflareArchitectureExpectation;
  metadata: {
    caseId: string;
    focus: string;
  };
};
type CloudflareArchitectureExperimentSummary = Awaited<ReturnType<Dataset['startExperiment']>>;

const workerDeploymentSignals = ['wrangler-dev-staging', 'wrangler-deploy-production'];
const workerDeploymentForbidden = ['github-actions-deploy'];

const expectedCloudflareScores = (overrides: Partial<Record<CloudflareArchitectureScorerId, number>> = {}) =>
  Object.fromEntries(
    cloudflareArchitectureScorerIds.map((scorerId) => [scorerId, overrides[scorerId] ?? 1]),
  ) as Record<CloudflareArchitectureScorerId, number>;

export const cloudflareArchitectureDatasetItems: CloudflareArchitectureDatasetItem[] = [
  {
    metadata: { caseId: 'worker-d1-auth-sessions', focus: 'worker-d1' },
    input: {
      caseId: 'worker-d1-auth-sessions',
      vision: 'Build a vanilla account app on Cloudflare Workers with login sessions and durable records.',
      spec: 'Use a standalone Worker. Sessions, users, and audit events must be queryable relational data.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'd1', 'static-assets'],
        bindings: ['DB'],
        taskOrder: [
          'root-scaffold',
          'wrangler-env-config',
          'binding-config',
          'd1-migration',
          'storage-adapter',
          'worker-routes',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'Workers handle the API and D1 is the relational source of truth.',
      },
    },
    groundTruth: {
      caseId: 'worker-d1-auth-sessions',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'd1', 'static-assets'],
      forbiddenComponents: ['pages-functions', 'node-http-server', 'filesystem-state'],
      requiredBindings: ['DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'storage-adapter',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Relational user/session state belongs in D1 behind a standalone Worker.',
    },
  },
  {
    metadata: { caseId: 'kv-rate-limit-cache', focus: 'kv' },
    input: {
      caseId: 'kv-rate-limit-cache',
      vision: 'Add lightweight request throttling and feature configuration to a Worker.',
      spec: 'Counters and configuration are cache-like data. No relational reporting is required.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'kv'],
        bindings: ['RATE_LIMITS'],
        taskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'worker-routes', 'release-gate'],
        deployment: workerDeploymentSignals,
        rationale: 'KV is enough for counters/config while the Worker remains the compute boundary.',
      },
    },
    groundTruth: {
      caseId: 'kv-rate-limit-cache',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'kv'],
      forbiddenComponents: ['pages-functions', 'd1-for-cache-only'],
      requiredBindings: ['RATE_LIMITS'],
      requiredTaskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'worker-routes', 'release-gate'],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'KV is appropriate for cache-like counters and configuration.',
    },
  },
  {
    metadata: { caseId: 'r2-uploads-d1-metadata', focus: 'r2-d1' },
    input: {
      caseId: 'r2-uploads-d1-metadata',
      vision: 'Let users upload source media and review generated derivatives from a vanilla Worker app.',
      spec: 'Binary files must be retained. Metadata, ownership, and processing status must be queryable.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'r2', 'd1'],
        bindings: ['ASSETS_BUCKET', 'DB'],
        taskOrder: [
          'root-scaffold',
          'wrangler-env-config',
          'binding-config',
          'd1-migration',
          'r2-adapter',
          'storage-adapter',
          'worker-routes',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'R2 stores file blobs, D1 stores ownership and lifecycle metadata.',
      },
    },
    groundTruth: {
      caseId: 'r2-uploads-d1-metadata',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'r2', 'd1'],
      forbiddenComponents: ['kv-as-file-store', 'filesystem-state'],
      requiredBindings: ['ASSETS_BUCKET', 'DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'r2-adapter',
        'storage-adapter',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'R2 and D1 should be paired when blobs and queryable metadata are both required.',
    },
  },
  {
    metadata: { caseId: 'workers-ai-vectorize-rag', focus: 'workers-ai-vectorize' },
    input: {
      caseId: 'workers-ai-vectorize-rag',
      vision: 'Build a Worker that answers questions from uploaded documents.',
      spec: 'The Worker should run inference, create embeddings, search semantically, and store source metadata.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'workers-ai', 'vectorize', 'd1'],
        bindings: ['AI', 'VECTORIZE', 'DB'],
        taskOrder: [
          'root-scaffold',
          'wrangler-env-config',
          'binding-config',
          'd1-migration',
          'vectorize-index',
          'ai-service',
          'worker-routes',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'Workers AI handles inference, Vectorize handles semantic lookup, and D1 stores metadata.',
      },
    },
    groundTruth: {
      caseId: 'workers-ai-vectorize-rag',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'workers-ai', 'vectorize', 'd1'],
      forbiddenComponents: ['external-vector-db-by-default'],
      requiredBindings: ['AI', 'VECTORIZE', 'DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'vectorize-index',
        'ai-service',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Workers AI needs an AI binding and Vectorize is the native semantic-search fit.',
    },
  },
  {
    metadata: { caseId: 'durable-object-realtime-room', focus: 'durable-objects' },
    input: {
      caseId: 'durable-object-realtime-room',
      vision: 'Create a real-time collaborative room experience in a Worker app.',
      spec: 'Each room needs strongly consistent state and live coordination between connected clients.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'durable-objects', 'd1'],
        bindings: ['ROOM_OBJECT', 'DB'],
        taskOrder: [
          'root-scaffold',
          'wrangler-env-config',
          'binding-config',
          'durable-object-class',
          'd1-migration',
          'worker-routes',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'Durable Objects own room coordination while D1 stores durable account/history records.',
      },
    },
    groundTruth: {
      caseId: 'durable-object-realtime-room',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'durable-objects', 'd1'],
      forbiddenComponents: ['kv-for-strong-consistency'],
      requiredBindings: ['ROOM_OBJECT', 'DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'durable-object-class',
        'd1-migration',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Durable Objects are the native choice for per-room coordination and stateful connections.',
    },
  },
  {
    metadata: { caseId: 'multi-worker-service-binding', focus: 'service-bindings' },
    input: {
      caseId: 'multi-worker-service-binding',
      vision: 'Split public ingestion from a separately iterated admin API and queue consumer.',
      spec: 'The services need independent iteration, a queue-backed ingestion flow, and direct Worker-to-Worker calls.',
      candidate: {
        topology: 'multi-worker',
        components: ['workers', 'service-bindings', 'queues', 'd1'],
        bindings: ['API_WORKER', 'INGEST_QUEUE', 'DB'],
        taskOrder: [
          'root-scaffold',
          'worker-boundaries',
          'wrangler-env-config',
          'binding-config',
          'd1-migration',
          'queue-consumer',
          'service-binding-router',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'Independent Worker services communicate through service bindings and queues.',
      },
    },
    groundTruth: {
      caseId: 'multi-worker-service-binding',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'multi-worker',
      requiredComponents: ['workers', 'service-bindings', 'queues', 'd1'],
      forbiddenComponents: ['pages-functions'],
      requiredBindings: ['API_WORKER', 'INGEST_QUEUE', 'DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'worker-boundaries',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'queue-consumer',
        'service-binding-router',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Independent iteration and Worker-to-Worker calls justify a multi-Worker topology.',
    },
  },
  {
    metadata: { caseId: 'explicit-pages-functions-site', focus: 'pages-exception' },
    input: {
      caseId: 'explicit-pages-functions-site',
      vision: 'This project must be a Cloudflare Pages site with Pages Functions.',
      spec: 'Use Pages Functions for a static marketing site contact form and KV-backed submission throttling.',
      candidate: {
        topology: 'pages-functions',
        pagesExceptionEvidence: 'vision.md says the project must be a Cloudflare Pages site with Pages Functions.',
        components: ['pages', 'pages-functions', 'kv'],
        bindings: ['FORM_CACHE'],
        taskOrder: ['pages-scaffold', 'wrangler-env-config', 'binding-config', 'pages-function-routes', 'release-gate'],
        deployment: ['pages-deploy'],
        rationale: 'Pages is acceptable because the source docs explicitly require it and the feature set fits.',
      },
    },
    groundTruth: {
      caseId: 'explicit-pages-functions-site',
      expectedScores: expectedCloudflareScores(),
      expectedTopology: 'pages-functions',
      requiredPagesExceptionEvidence: true,
      requiredComponents: ['pages', 'pages-functions', 'kv'],
      forbiddenComponents: ['workers-api-split'],
      requiredBindings: ['FORM_CACHE'],
      requiredTaskOrder: ['pages-scaffold', 'wrangler-env-config', 'binding-config', 'pages-function-routes', 'release-gate'],
      requiredDeploymentSignals: ['pages-deploy'],
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Pages is only valid here because vision/spec declaratively require it.',
    },
  },
  {
    metadata: { caseId: 'silent-pages-workers-split', focus: 'pages-misuse' },
    input: {
      caseId: 'silent-pages-workers-split',
      vision: 'Build a small Worker app with D1-backed records.',
      spec: 'The spec is silent about Pages and asks for a standalone Worker.',
      candidate: {
        topology: 'mixed',
        components: ['pages-functions', 'node-http-server'],
        bindings: [],
        taskOrder: [],
        deployment: ['github-actions-deploy'],
        rationale: 'Static Pages and a Node server seem easier for a small app.',
      },
    },
    groundTruth: {
      caseId: 'silent-pages-workers-split',
      expectedScores: expectedCloudflareScores({
        'cloudflare-worker-first-topology': 0,
        'cloudflare-storage-fit': 0,
        'cloudflare-bindings-hygiene': 0,
        'cloudflare-task-sequencing': 0,
        'cloudflare-deployment-hygiene': 0,
      }),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'd1'],
      forbiddenComponents: ['pages-functions', 'node-http-server'],
      requiredBindings: ['DB'],
      requiredTaskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'd1-migration', 'worker-routes', 'release-gate'],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'A silent Pages/Workers split violates the Worker-first consistency rule.',
    },
  },
  {
    metadata: { caseId: 'relational-session-kv-misuse', focus: 'storage-misfit' },
    input: {
      caseId: 'relational-session-kv-misuse',
      vision: 'Build account sessions with audit history and per-user reporting.',
      spec: 'Sessions must be invalidated server-side and queryable by user and status.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'kv-as-source-of-truth'],
        bindings: ['SESSION_CACHE'],
        taskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'worker-routes', 'release-gate'],
        deployment: workerDeploymentSignals,
        rationale: 'KV is simple for session tokens.',
      },
    },
    groundTruth: {
      caseId: 'relational-session-kv-misuse',
      expectedScores: expectedCloudflareScores({
        'cloudflare-storage-fit': 0.333,
        'cloudflare-bindings-hygiene': 0,
        'cloudflare-task-sequencing': 0.714,
      }),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'd1'],
      forbiddenComponents: ['kv-as-source-of-truth'],
      requiredBindings: ['DB'],
      forbiddenBindings: ['SESSION_CACHE'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'storage-adapter',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Relational, queryable session state should use D1, not KV as source of truth.',
    },
  },
  {
    metadata: { caseId: 'workers-ai-missing-binding', focus: 'binding-hygiene' },
    input: {
      caseId: 'workers-ai-missing-binding',
      vision: 'Use Workers AI to summarize uploaded notes.',
      spec: 'The Worker must invoke Workers AI and retain summaries in D1.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'workers-ai', 'd1'],
        bindings: ['DB'],
        taskOrder: [
          'root-scaffold',
          'wrangler-env-config',
          'binding-config',
          'd1-migration',
          'ai-service',
          'worker-routes',
          'release-gate',
        ],
        deployment: workerDeploymentSignals,
        rationale: 'Workers AI and D1 cover the feature.',
      },
    },
    groundTruth: {
      caseId: 'workers-ai-missing-binding',
      expectedScores: expectedCloudflareScores({
        'cloudflare-bindings-hygiene': 0.5,
      }),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'workers-ai', 'd1'],
      requiredBindings: ['AI', 'DB'],
      requiredTaskOrder: [
        'root-scaffold',
        'wrangler-env-config',
        'binding-config',
        'd1-migration',
        'ai-service',
        'worker-routes',
        'release-gate',
      ],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'Workers AI requires the AI binding to be declared and mirrored across environments.',
    },
  },
  {
    metadata: { caseId: 'github-actions-deploy-path', focus: 'deployment-hygiene' },
    input: {
      caseId: 'github-actions-deploy-path',
      vision: 'Build a normal Worker with D1 and validate locally before production.',
      spec: 'Use Wrangler for local validation and require human approval before production deploy.',
      candidate: {
        topology: 'single-worker',
        components: ['workers', 'd1'],
        bindings: ['DB'],
        taskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'd1-migration', 'worker-routes', 'release-gate'],
        deployment: ['github-actions-deploy'],
        rationale: 'GitHub Actions can deploy the Worker automatically.',
      },
    },
    groundTruth: {
      caseId: 'github-actions-deploy-path',
      expectedScores: expectedCloudflareScores({
        'cloudflare-deployment-hygiene': 0,
      }),
      expectedTopology: 'single-worker',
      requiredComponents: ['workers', 'd1'],
      requiredBindings: ['DB'],
      requiredTaskOrder: ['root-scaffold', 'wrangler-env-config', 'binding-config', 'd1-migration', 'worker-routes', 'release-gate'],
      requiredDeploymentSignals: workerDeploymentSignals,
      forbiddenDeploymentSignals: workerDeploymentForbidden,
      rationale: 'The harness should prefer direct Wrangler CLI deploys, not GitHub Actions deployment.',
    },
  },
];

export type CloudflareArchitectureScoreMismatch = {
  itemId: string;
  caseId: string;
  scorerId: string;
  expected: number;
  actual: number | null;
  reason?: string | null;
};

export type CloudflareArchitectureVerdict = 'passed' | 'scored' | 'failed';

export type CloudflareArchitectureGateResult = {
  id: string;
  passed: boolean;
  score: number;
  reason: string;
};

export type CloudflareArchitectureThreshold = number | { min?: number; max?: number };

export type CloudflareArchitectureThresholdResult = {
  id: string;
  passed: boolean;
  averageScore: number;
  threshold: CloudflareArchitectureThreshold;
  reason: string;
};

export type CloudflareArchitectureScorerCoverage = {
  scorerId: string;
  expectedItems: number;
  scoredItems: number;
  positiveExamples: number;
  negativeExamples: number;
  missingScoreCaseIds: string[];
};

export type CloudflareArchitectureCoverageReport = {
  totalScorers: number;
  coveredScorers: number;
  missingScorers: string[];
  totalExpectations: number;
  scorerCoverage: CloudflareArchitectureScorerCoverage[];
};

export type CloudflareArchitectureGateThresholds = {
  minTotalItems: number;
  minSucceededRate: number;
  maxFailedItems: number;
  maxMismatches: number;
  maxPersistenceFailures: number;
  minScorerCoverageRate: number;
  minScoreAlignmentRate: number;
};

export type CloudflareArchitectureGateReport = {
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
  coverage: CloudflareArchitectureCoverageReport;
  thresholds: CloudflareArchitectureGateThresholds;
  gateResults: CloudflareArchitectureGateResult[];
  thresholdResults: CloudflareArchitectureThresholdResult[];
  verdict: CloudflareArchitectureVerdict;
  mismatches: CloudflareArchitectureScoreMismatch[];
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

export const cloudflareArchitectureGateThresholds: CloudflareArchitectureGateThresholds = {
  minTotalItems: cloudflareArchitectureDatasetItems.length,
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

export async function ensureCloudflareArchitectureDataset(mastra: Mastra) {
  const existing = await mastra.datasets.list({
    filters: {
      name: cloudflareArchitectureDatasetName,
      targetType: 'scorer',
      targetIds: [...cloudflareArchitectureScorerIds],
    },
    perPage: 20,
  });
  const existingRecord = existing.datasets.find((dataset) => dataset.name === cloudflareArchitectureDatasetName);
  const dataset = existingRecord
    ? await mastra.datasets.get({ id: existingRecord.id })
    : await mastra.datasets.create({
        name: cloudflareArchitectureDatasetName,
        description: 'Regression dataset for Cloudflare-native Worker architecture decisions.',
        inputSchema: cloudflareArchitectureInputSchema,
        groundTruthSchema: cloudflareArchitectureExpectationSchema,
        targetType: 'scorer',
        targetIds: [...cloudflareArchitectureScorerIds],
        scorerIds: [...cloudflareArchitectureScorerIds],
        metadata: {
          suite: 'delivery-engine',
          kind: 'cloudflare-architecture-regression',
          suiteVersion: cloudflareArchitectureSuiteVersion,
          scorerIds: [...cloudflareArchitectureScorerIds],
        },
      });

  if (existingRecord) {
    await dataset.update({
      description: 'Regression dataset for Cloudflare-native Worker architecture decisions.',
      inputSchema: cloudflareArchitectureInputSchema,
      groundTruthSchema: cloudflareArchitectureExpectationSchema,
      targetType: 'scorer',
      targetIds: [...cloudflareArchitectureScorerIds],
      scorerIds: [...cloudflareArchitectureScorerIds],
      metadata: {
        suite: 'delivery-engine',
        kind: 'cloudflare-architecture-regression',
        suiteVersion: cloudflareArchitectureSuiteVersion,
        scorerIds: [...cloudflareArchitectureScorerIds],
      },
    });
  }

  const listedItems = datasetItemsFromListResult(await dataset.listItems({ page: 0, perPage: 100 }));
  const existingByCaseId = new Map(
    listedItems
      .map((item) => [typeof item.metadata?.caseId === 'string' ? item.metadata.caseId : undefined, item] as const)
      .filter((entry): entry is readonly [string, (typeof listedItems)[number]] => Boolean(entry[0])),
  );

  for (const item of cloudflareArchitectureDatasetItems) {
    const existingItem = existingByCaseId.get(item.metadata.caseId);
    if (existingItem) {
      await dataset.updateItem({ itemId: existingItem.id, ...item });
    } else {
      await dataset.addItem(item);
    }
  }

  return dataset;
}

export function collectCloudflareArchitectureScoreMismatches(
  summary: CloudflareArchitectureExperimentSummary,
  tolerance = 0.001,
): CloudflareArchitectureScoreMismatch[] {
  return summary.results.flatMap((result) => {
    const groundTruth = cloudflareArchitectureExpectationSchema.safeParse(result.groundTruth);
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

function thresholdPassed(value: number, threshold: CloudflareArchitectureThreshold) {
  if (typeof threshold === 'number') return value >= threshold;
  if (typeof threshold.min === 'number' && value < threshold.min) return false;
  if (typeof threshold.max === 'number' && value > threshold.max) return false;
  return true;
}

function thresholdReason(id: string, value: number, threshold: CloudflareArchitectureThreshold) {
  if (typeof threshold === 'number') return `${id} ${value} must be at least ${threshold}.`;
  const parts = [];
  if (typeof threshold.min === 'number') parts.push(`at least ${threshold.min}`);
  if (typeof threshold.max === 'number') parts.push(`at most ${threshold.max}`);
  return `${id} ${value} must be ${parts.join(' and ')}.`;
}

export function buildCloudflareArchitectureCoverageReport(
  summary: Pick<CloudflareArchitectureExperimentSummary, 'results'>,
): CloudflareArchitectureCoverageReport {
  const scorerCoverage = cloudflareArchitectureScorerIds.map((scorerId) => {
    let expectedItems = 0;
    let scoredItems = 0;
    let positiveExamples = 0;
    let negativeExamples = 0;
    const missingScoreCaseIds: string[] = [];

    for (const result of summary.results) {
      const groundTruth = cloudflareArchitectureExpectationSchema.safeParse(result.groundTruth);
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
    totalScorers: cloudflareArchitectureScorerIds.length,
    coveredScorers: cloudflareArchitectureScorerIds.length - missingScorers.length,
    missingScorers,
    totalExpectations: scorerCoverage.reduce((sum, coverage) => sum + coverage.expectedItems, 0),
    scorerCoverage,
  };
}

function buildGateResult({
  id,
  passed,
  reason,
}: {
  id: string;
  passed: boolean;
  reason: string;
}): CloudflareArchitectureGateResult {
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
  threshold: CloudflareArchitectureThreshold;
}): CloudflareArchitectureThresholdResult {
  const passed = thresholdPassed(averageScore, threshold);
  return {
    id,
    passed,
    averageScore,
    threshold,
    reason: passed ? `${id} ${averageScore} satisfies threshold.` : thresholdReason(id, averageScore, threshold),
  };
}

function scorerAverages(summary: CloudflareArchitectureExperimentSummary) {
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

export function buildCloudflareArchitectureGateReport({
  datasetId,
  summary,
  mismatches,
  thresholds = cloudflareArchitectureGateThresholds,
  previousReport,
}: {
  datasetId: string;
  summary: CloudflareArchitectureExperimentSummary;
  mismatches: CloudflareArchitectureScoreMismatch[];
  thresholds?: CloudflareArchitectureGateThresholds;
  previousReport?: CloudflareArchitectureGateReport;
}): CloudflareArchitectureGateReport {
  const succeededRate = summary.totalItems ? rounded(summary.succeededCount / summary.totalItems) : 0;
  const persistenceFailures = summary.persistenceFailures ?? 0;
  const coverage = buildCloudflareArchitectureCoverageReport(summary);
  const scorerCoverageRate = coverage.totalScorers ? rounded(coverage.coveredScorers / coverage.totalScorers) : 0;
  const scoreAlignmentRate = coverage.totalExpectations
    ? rounded((coverage.totalExpectations - mismatches.length) / coverage.totalExpectations)
    : 0;

  const gateResults: CloudflareArchitectureGateResult[] = [
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
        ? `Missing positive/negative coverage for Cloudflare scorer(s): ${coverage.missingScorers.join(', ')}.`
        : 'Every Cloudflare architecture scorer has positive and negative regression coverage.',
    }),
  ];

  const thresholdResults: CloudflareArchitectureThresholdResult[] = [
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

  const verdict: CloudflareArchitectureVerdict = gateResults.some((result) => !result.passed)
    ? 'failed'
    : thresholdResults.some((result) => !result.passed)
      ? 'scored'
      : 'passed';
  const reasons = [
    ...gateResults.filter((result) => !result.passed).map((result) => result.reason),
    ...thresholdResults.filter((result) => !result.passed).map((result) => result.reason),
  ];

  const currentAverages = scorerAverages(summary);
  const report: CloudflareArchitectureGateReport = {
    generatedAt: new Date().toISOString(),
    suiteVersion: cloudflareArchitectureSuiteVersion,
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

export async function runCloudflareArchitectureExperiment(
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
  const dataset = await ensureCloudflareArchitectureDataset(mastra);
  const summary = await dataset.startExperiment({
    name: options.name ?? `cloudflare-architecture-regression-${new Date().toISOString()}`,
    description: options.description ?? 'Cloudflare architecture regression experiment.',
    task: ({ input }) => cloudflareArchitectureInputSchema.parse(input).candidate,
    scorers: [...cloudflareArchitectureScorerIds],
    maxConcurrency: options.maxConcurrency ?? 4,
    itemTimeout: options.itemTimeout ?? 10_000,
    metadata: {
      suite: 'delivery-engine',
      kind: 'cloudflare-architecture-regression',
      suiteVersion: cloudflareArchitectureSuiteVersion,
      scorerIds: [...cloudflareArchitectureScorerIds],
      ...options.metadata,
    },
  });
  const mismatches = collectCloudflareArchitectureScoreMismatches(summary);

  if (options.failOnMismatch !== false && mismatches.length) {
    throw new Error(
      `Cloudflare architecture experiment found ${mismatches.length} score mismatch(es): ${mismatches
        .map((mismatch) => `${mismatch.caseId}/${mismatch.scorerId} expected ${mismatch.expected}, got ${mismatch.actual}`)
        .join('; ')}`,
    );
  }

  return { dataset, summary, mismatches };
}
