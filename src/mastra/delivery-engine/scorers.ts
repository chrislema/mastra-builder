import { createScorer, type MastraScorers, type ScoringSamplingConfig } from '@mastra/core/evals';

type DeliveryJudgmentRef = {
  subject: string;
  rubric: string;
  path: string;
  overall: number;
  passed: boolean;
};

type DeliveryCheckRef = {
  check: string;
  passed: boolean;
  reason: string;
};

type DeliveryTaskPlanRef = {
  tasks?: unknown[];
};

type DeliveryReleaseGateRef = {
  decision?: string;
  blockers?: string[];
};

export type DeliveryWorkflowScorerOutput = {
  status?: string;
  runId?: string;
  summary?: string;
  taskPlan?: DeliveryTaskPlanRef;
  releaseGate?: DeliveryReleaseGateRef;
  checks?: DeliveryCheckRef[];
  judgments?: DeliveryJudgmentRef[];
  nextSteps?: string[];
};

export type CloudflareArchitectureScorerOutput = {
  topology?: string;
  pagesExceptionEvidence?: string;
  components?: string[];
  bindings?: string[];
  taskOrder?: string[];
  deployment?: string[];
  rationale?: string;
  risks?: string[];
};

type CloudflareArchitectureGroundTruth = {
  caseId?: string;
  expectedTopology?: string;
  requiredPagesExceptionEvidence?: boolean;
  requiredComponents?: string[];
  forbiddenComponents?: string[];
  requiredBindings?: string[];
  forbiddenBindings?: string[];
  requiredTaskOrder?: string[];
  requiredDeploymentSignals?: string[];
  forbiddenDeploymentSignals?: string[];
  rationale?: string;
};

function asDeliveryOutput(output: unknown): DeliveryWorkflowScorerOutput {
  if (!output || typeof output !== 'object') return {};
  return output as DeliveryWorkflowScorerOutput;
}

function asCloudflareArchitectureOutput(output: unknown): CloudflareArchitectureScorerOutput {
  if (!output || typeof output !== 'object') return {};
  return output as CloudflareArchitectureScorerOutput;
}

function asCloudflareGroundTruth(groundTruth: unknown): CloudflareArchitectureGroundTruth {
  if (!groundTruth || typeof groundTruth !== 'object') return {};
  return groundTruth as CloudflareArchitectureGroundTruth;
}

function deliveryJudgments(output: unknown) {
  return asDeliveryOutput(output).judgments ?? [];
}

function deliveryChecks(output: unknown) {
  return asDeliveryOutput(output).checks ?? [];
}

function deliveryAcceptanceContractChecks(output: unknown) {
  return deliveryChecks(output).filter((check) =>
    ['acceptance_criteria_contracts', 'task_plan_acceptance_contract_regression'].includes(check.check),
  );
}

const rounded = (score: number) => Math.round(score * 1000) / 1000;
const scoreEveryRun = { type: 'ratio', rate: 1 } satisfies ScoringSamplingConfig;

function stringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
  }

  return typeof value === 'string' ? [value] : [];
}

function normalizeSignal(value: string) {
  return value
    .toLowerCase()
    .replace(/workers ai/g, 'workers-ai')
    .replace(/durable objects/g, 'durable-objects')
    .replace(/service bindings/g, 'service-bindings')
    .replace(/pages functions/g, 'pages-functions')
    .replace(/github actions/g, 'github-actions')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasSignal(actual: string[], expected: string) {
  const normalizedExpected = normalizeSignal(expected);
  return actual.some((candidate) => {
    const normalizedCandidate = normalizeSignal(candidate);
    return (
      normalizedCandidate === normalizedExpected ||
      normalizedCandidate.includes(normalizedExpected) ||
      normalizedExpected.includes(normalizedCandidate)
    );
  });
}

function scoreSignalContract({
  actual,
  required = [],
  forbidden = [],
}: {
  actual: string[];
  required?: string[];
  forbidden?: string[];
}) {
  const missing = required.filter((signal) => !hasSignal(actual, signal));
  const forbiddenPresent = forbidden.filter((signal) => hasSignal(actual, signal));
  const total = required.length + forbidden.length;
  const score = total ? rounded(Math.max(0, total - missing.length - forbiddenPresent.length) / total) : 1;

  return { score, missing, forbiddenPresent };
}

function cloudflareArchitectureSignals(output: CloudflareArchitectureScorerOutput) {
  return [output.topology, ...stringList(output.components)].filter((signal): signal is string => Boolean(signal));
}

function cloudflareSignalReason({
  passReason,
  failPrefix,
  missing,
  forbiddenPresent,
}: {
  passReason: string;
  failPrefix: string;
  missing: string[];
  forbiddenPresent: string[];
}) {
  if (!missing.length && !forbiddenPresent.length) return passReason;
  const parts = [];
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  if (forbiddenPresent.length) parts.push(`forbidden present: ${forbiddenPresent.join(', ')}`);
  return `${failPrefix} ${parts.join('; ')}.`;
}

function orderedMatches(actual: string[], required: string[]) {
  let cursor = 0;
  let matched = 0;
  const missingOrOutOfOrder: string[] = [];

  for (const expected of required) {
    const nextIndex = actual.findIndex((candidate, index) => index >= cursor && hasSignal([candidate], expected));
    if (nextIndex === -1) {
      missingOrOutOfOrder.push(expected);
      continue;
    }

    matched += 1;
    cursor = nextIndex + 1;
  }

  return {
    matched,
    missingOrOutOfOrder,
    score: required.length ? rounded(matched / required.length) : 1,
  };
}

function createHandoffReadinessScorer({
  id,
  name,
  description,
  expectedStatus,
  nextRole,
  extraReason,
}: {
  id: string;
  name: string;
  description: string;
  expectedStatus: string;
  nextRole: string;
  extraReason?: (output: DeliveryWorkflowScorerOutput) => string | undefined;
}) {
  return createScorer<unknown, DeliveryWorkflowScorerOutput>({
    id,
    name,
    description,
  })
    .generateScore(({ run }) => (asDeliveryOutput(run.output).status === expectedStatus ? 1 : 0))
    .generateReason(({ run, score }) => {
      const output = asDeliveryOutput(run.output);
      if (score === 1) {
        const extra = extraReason?.(output);
        return extra ?? `Handoff is ready for ${nextRole}.`;
      }

      return `Handoff is not ready for ${nextRole}. Expected status ${expectedStatus}, got ${
        output.status ?? 'unknown'
      }. ${output.summary ?? ''}`.trim();
    });
}

export const deliveryPlanToArchitectHandoffScorer = createHandoffReadinessScorer({
  id: 'delivery-plan-to-architect-handoff',
  name: 'Delivery Plan To Architect Handoff',
  description: 'Scores whether planner output is ready for architect review.',
  expectedStatus: 'planned',
  nextRole: 'architect',
  extraReason: (output) => {
    const taskCount = output.taskPlan?.tasks?.length;
    return `Planner handoff is ready for architect review${taskCount ? ` with ${taskCount} task(s)` : ''}.`;
  },
});

export const deliveryArchitectToBuildHandoffScorer = createHandoffReadinessScorer({
  id: 'delivery-architect-to-build-handoff',
  name: 'Delivery Architect To Build Handoff',
  description: 'Scores whether architect review approved the plan for build.',
  expectedStatus: 'reviewed',
  nextRole: 'engineer/designer',
});

export const deliveryBuildToTesterHandoffScorer = createHandoffReadinessScorer({
  id: 'delivery-build-to-tester-handoff',
  name: 'Delivery Build To Tester Handoff',
  description: 'Scores whether the build loop completed and is ready for tester release gating.',
  expectedStatus: 'built',
  nextRole: 'tester',
});

export const deliveryTesterToDeployerHandoffScorer = createHandoffReadinessScorer({
  id: 'delivery-tester-to-deployer-handoff',
  name: 'Delivery Tester To Deployment Handoff',
  description: 'Scores whether tester release gating passed and the native deployment stage may proceed.',
  expectedStatus: 'release_ready',
  nextRole: 'deployment workflow',
  extraReason: (output) =>
    output.releaseGate?.decision === 'pass'
      ? 'Tester handoff is ready for the native deployment stage with a passing release gate.'
      : 'Tester handoff is ready for the native deployment stage.',
});

export const deliveryWorkflowCompletionScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-workflow-completion',
  name: 'Delivery Workflow Completion',
  description: 'Scores 1 only when the Delivery Engine workflow finishes complete.',
})
  .generateScore(({ run }) => (asDeliveryOutput(run.output).status === 'complete' ? 1 : 0))
  .generateReason(({ run, score }) => {
    const output = asDeliveryOutput(run.output);
    return score === 1
      ? `Delivery workflow completed: ${output.summary ?? 'complete'}`
      : `Delivery workflow did not complete. Status: ${output.status ?? 'unknown'}.`;
  });

export const deliveryRubricFloorScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-rubric-floor',
  name: 'Delivery Rubric Floor',
  description: 'Scores the lowest recorded rubric judgment for a delivery workflow run.',
})
  .generateScore(({ run }) => {
    const judgments = deliveryJudgments(run.output);
    if (!judgments.length) return 0;
    return rounded(Math.min(...judgments.map((judgment) => judgment.overall)));
  })
  .generateReason(({ run, score }) => {
    const judgments = deliveryJudgments(run.output);
    if (!judgments.length) return 'No rubric judgments were recorded.';
    const floor = judgments.reduce((lowest, judgment) => (judgment.overall < lowest.overall ? judgment : lowest));
    return `Lowest rubric judgment is ${score}: ${floor.rubric} for ${floor.subject}.`;
  });

export const deliveryJudgmentPassRateScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-judgment-pass-rate',
  name: 'Delivery Judgment Pass Rate',
  description: 'Scores the fraction of recorded rubric judgments that passed.',
})
  .generateScore(({ run }) => {
    const judgments = deliveryJudgments(run.output);
    if (!judgments.length) return 0;
    return rounded(judgments.filter((judgment) => judgment.passed).length / judgments.length);
  })
  .generateReason(({ run, score }) => {
    const judgments = deliveryJudgments(run.output);
    const failed = judgments.filter((judgment) => !judgment.passed);
    if (!judgments.length) return 'No rubric judgments were recorded.';
    if (!failed.length) return `All ${judgments.length} rubric judgment(s) passed.`;
    return `${score} pass rate. Failed judgments: ${failed.map((judgment) => judgment.rubric).join(', ')}.`;
  });

export const deliveryDeterministicChecksScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-deterministic-checks',
  name: 'Delivery Deterministic Checks',
  description: 'Scores the fraction of deterministic delivery checks that passed.',
})
  .generateScore(({ run }) => {
    const checks = deliveryChecks(run.output);
    if (!checks.length) return 0;
    return rounded(checks.filter((check) => check.passed).length / checks.length);
  })
  .generateReason(({ run, score }) => {
    const checks = deliveryChecks(run.output);
    const failed = checks.filter((check) => !check.passed);
    if (!checks.length) return 'No deterministic checks were recorded.';
    if (!failed.length) return `All ${checks.length} deterministic check(s) passed.`;
    return `${score} check pass rate. Failed checks: ${failed.map((check) => `${check.check}: ${check.reason}`).join('; ')}.`;
  });

export const deliveryAcceptanceContractCoverageScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-acceptance-contract-coverage',
  name: 'Delivery Acceptance Contract Coverage',
  description: 'Scores whether first-class acceptance contract checks are present and passing.',
})
  .generateScore(({ run }) => {
    const checks = deliveryAcceptanceContractChecks(run.output);
    if (!checks.length) return 0;
    return rounded(checks.filter((check) => check.passed).length / checks.length);
  })
  .generateReason(({ run, score }) => {
    const checks = deliveryAcceptanceContractChecks(run.output);
    if (!checks.length) return 'No acceptance contract checks were recorded.';
    const failed = checks.filter((check) => !check.passed);
    if (!failed.length) return `All ${checks.length} acceptance contract check(s) passed.`;
    return `${score} acceptance contract coverage. Failed contracts: ${failed
      .map((check) => `${check.check}: ${check.reason}`)
      .join('; ')}.`;
  });

export const cloudflareWorkerFirstTopologyScorer = createScorer<unknown, CloudflareArchitectureScorerOutput>({
  id: 'cloudflare-worker-first-topology',
  name: 'Cloudflare Worker First Topology',
  description: 'Scores whether the architecture defaults to Workers or uses Pages only by explicit exception.',
})
  .generateScore(({ run }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const expectedTopology = groundTruth.expectedTopology ?? 'single-worker';
    const required = expectedTopology ? [expectedTopology] : [];
    const forbidden = expectedTopology.includes('pages') ? ['mixed'] : ['pages', 'pages-functions', 'mixed'];
    const { score } = scoreSignalContract({
      actual: cloudflareArchitectureSignals(output),
      required,
      forbidden,
    });

    if (expectedTopology.includes('pages') && groundTruth.requiredPagesExceptionEvidence !== false) {
      return output.pagesExceptionEvidence?.trim() ? score : 0;
    }

    return score;
  })
  .generateReason(({ run, score }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const expectedTopology = groundTruth.expectedTopology ?? 'single-worker';
    const forbidden = expectedTopology.includes('pages') ? ['mixed'] : ['pages', 'pages-functions', 'mixed'];
    const contract = scoreSignalContract({
      actual: cloudflareArchitectureSignals(output),
      required: expectedTopology ? [expectedTopology] : [],
      forbidden,
    });

    if (expectedTopology.includes('pages') && groundTruth.requiredPagesExceptionEvidence !== false && !output.pagesExceptionEvidence?.trim()) {
      return 'Pages topology is only acceptable with explicit vision/spec evidence, and none was provided.';
    }

    return cloudflareSignalReason({
      passReason: `Topology matches the expected Cloudflare deployment model (${expectedTopology}).`,
      failPrefix: `Topology scored ${score}; expected ${expectedTopology}.`,
      missing: contract.missing,
      forbiddenPresent: contract.forbiddenPresent,
    });
  });

export const cloudflareStorageFitScorer = createScorer<unknown, CloudflareArchitectureScorerOutput>({
  id: 'cloudflare-storage-fit',
  name: 'Cloudflare Storage And Service Fit',
  description: 'Scores whether selected Cloudflare services fit the required data, AI, queueing, and coordination needs.',
})
  .generateScore(({ run }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    return scoreSignalContract({
      actual: stringList(output.components),
      required: groundTruth.requiredComponents ?? [],
      forbidden: groundTruth.forbiddenComponents ?? [],
    }).score;
  })
  .generateReason(({ run, score }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const contract = scoreSignalContract({
      actual: stringList(output.components),
      required: groundTruth.requiredComponents ?? [],
      forbidden: groundTruth.forbiddenComponents ?? [],
    });

    return cloudflareSignalReason({
      passReason: 'Cloudflare services fit the fixture contract.',
      failPrefix: `Cloudflare service fit scored ${score}.`,
      missing: contract.missing,
      forbiddenPresent: contract.forbiddenPresent,
    });
  });

export const cloudflareBindingsHygieneScorer = createScorer<unknown, CloudflareArchitectureScorerOutput>({
  id: 'cloudflare-bindings-hygiene',
  name: 'Cloudflare Bindings Hygiene',
  description: 'Scores whether required Wrangler bindings and environment-facing names are planned explicitly.',
})
  .generateScore(({ run }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    return scoreSignalContract({
      actual: stringList(output.bindings),
      required: groundTruth.requiredBindings ?? [],
      forbidden: groundTruth.forbiddenBindings ?? [],
    }).score;
  })
  .generateReason(({ run, score }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const contract = scoreSignalContract({
      actual: stringList(output.bindings),
      required: groundTruth.requiredBindings ?? [],
      forbidden: groundTruth.forbiddenBindings ?? [],
    });

    return cloudflareSignalReason({
      passReason: 'Required Cloudflare bindings are present.',
      failPrefix: `Cloudflare binding hygiene scored ${score}.`,
      missing: contract.missing,
      forbiddenPresent: contract.forbiddenPresent,
    });
  });

export const cloudflareTaskSequencingScorer = createScorer<unknown, CloudflareArchitectureScorerOutput>({
  id: 'cloudflare-task-sequencing',
  name: 'Cloudflare Task Sequencing',
  description: 'Scores whether Worker scaffolding, migrations, bindings, implementation, and gates are ordered safely.',
})
  .generateScore(({ run }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    return orderedMatches(stringList(output.taskOrder), groundTruth.requiredTaskOrder ?? []).score;
  })
  .generateReason(({ run, score }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const result = orderedMatches(stringList(output.taskOrder), groundTruth.requiredTaskOrder ?? []);
    if (!result.missingOrOutOfOrder.length) return 'Cloudflare task sequence preserves the expected implementation order.';
    return `Cloudflare task sequence scored ${score}; missing or out of order: ${result.missingOrOutOfOrder.join(', ')}.`;
  });

export const cloudflareDeploymentHygieneScorer = createScorer<unknown, CloudflareArchitectureScorerOutput>({
  id: 'cloudflare-deployment-hygiene',
  name: 'Cloudflare Deployment Hygiene',
  description: 'Scores whether deployment plans use local Wrangler validation and direct Wrangler production deploys.',
})
  .generateScore(({ run }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    return scoreSignalContract({
      actual: stringList(output.deployment),
      required: groundTruth.requiredDeploymentSignals ?? [],
      forbidden: groundTruth.forbiddenDeploymentSignals ?? ['github-actions-deploy'],
    }).score;
  })
  .generateReason(({ run, score }) => {
    const output = asCloudflareArchitectureOutput(run.output);
    const groundTruth = asCloudflareGroundTruth(run.groundTruth);
    const contract = scoreSignalContract({
      actual: stringList(output.deployment),
      required: groundTruth.requiredDeploymentSignals ?? [],
      forbidden: groundTruth.forbiddenDeploymentSignals ?? ['github-actions-deploy'],
    });

    return cloudflareSignalReason({
      passReason: 'Deployment plan uses the expected Wrangler validation and deploy path.',
      failPrefix: `Cloudflare deployment hygiene scored ${score}.`,
      missing: contract.missing,
      forbiddenPresent: contract.forbiddenPresent,
    });
  });

export const deliveryScorers = {
  deliveryPlanToArchitectHandoffScorer,
  deliveryArchitectToBuildHandoffScorer,
  deliveryBuildToTesterHandoffScorer,
  deliveryTesterToDeployerHandoffScorer,
  deliveryWorkflowCompletionScorer,
  deliveryRubricFloorScorer,
  deliveryJudgmentPassRateScorer,
  deliveryDeterministicChecksScorer,
  deliveryAcceptanceContractCoverageScorer,
  cloudflareWorkerFirstTopologyScorer,
  cloudflareStorageFitScorer,
  cloudflareBindingsHygieneScorer,
  cloudflareTaskSequencingScorer,
  cloudflareDeploymentHygieneScorer,
};

const deliveryQualityStepScorers = {
  rubricFloor: {
    scorer: deliveryRubricFloorScorer,
    sampling: scoreEveryRun,
  },
  judgmentPassRate: {
    scorer: deliveryJudgmentPassRateScorer,
    sampling: scoreEveryRun,
  },
  deterministicChecks: {
    scorer: deliveryDeterministicChecksScorer,
    sampling: scoreEveryRun,
  },
  acceptanceContractCoverage: {
    scorer: deliveryAcceptanceContractCoverageScorer,
    sampling: scoreEveryRun,
  },
} satisfies MastraScorers;

export const deliveryPlanStepScorers: MastraScorers = {
  planToArchitect: {
    scorer: deliveryPlanToArchitectHandoffScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

export const deliveryReviewStepScorers: MastraScorers = {
  architectToBuild: {
    scorer: deliveryArchitectToBuildHandoffScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

export const deliveryBuildStepScorers: MastraScorers = {
  buildToTester: {
    scorer: deliveryBuildToTesterHandoffScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

export const deliveryReleaseGateStepScorers: MastraScorers = {
  testerToDeployer: {
    scorer: deliveryTesterToDeployerHandoffScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

export const deliveryDeploymentStepScorers: MastraScorers = {
  completion: {
    scorer: deliveryWorkflowCompletionScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};
