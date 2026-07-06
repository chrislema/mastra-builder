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

function asDeliveryOutput(output: unknown): DeliveryWorkflowScorerOutput {
  if (!output || typeof output !== 'object') return {};
  return output as DeliveryWorkflowScorerOutput;
}

function deliveryJudgments(output: unknown) {
  return asDeliveryOutput(output).judgments ?? [];
}

function deliveryChecks(output: unknown) {
  return asDeliveryOutput(output).checks ?? [];
}

const rounded = (score: number) => Math.round(score * 1000) / 1000;
const scoreEveryRun = { type: 'ratio', rate: 1 } satisfies ScoringSamplingConfig;

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

export const deliveryScorers = {
  deliveryPlanToArchitectHandoffScorer,
  deliveryArchitectToBuildHandoffScorer,
  deliveryBuildToTesterHandoffScorer,
  deliveryTesterToDeployerHandoffScorer,
  deliveryWorkflowCompletionScorer,
  deliveryRubricFloorScorer,
  deliveryJudgmentPassRateScorer,
  deliveryDeterministicChecksScorer,
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
