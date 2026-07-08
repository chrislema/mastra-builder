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

type DeliverySourcePolicyRef = {
  pagesRequired?: boolean;
  latestTranscriptRequired?: boolean;
  externalServiceBindings?: string[];
};

type DeliveryScaffoldManifestRef = {
  profileList?: string[];
  language?: string;
  main?: string;
  generatedFiles?: string[];
  testRuntimeMatrix?: Array<{ name?: string; runtime?: string; include?: string[] }>;
  bindingMap?: Record<string, string>;
  packageScripts?: Record<string, string>;
  validationCommands?: string[];
};

type DeliveryModelSpendRef = {
  totalTokens?: number;
  totalCostUsd?: number;
  completedTasks?: number;
  maxTokensPerTask?: number;
  maxCostPerTaskUsd?: number;
};

export type DeliveryWorkflowScorerOutput = {
  status?: string;
  runId?: string;
  deployMode?: string;
  summary?: string;
  sourcePolicy?: DeliverySourcePolicyRef;
  scaffoldManifest?: DeliveryScaffoldManifestRef;
  taskPlan?: DeliveryTaskPlanRef;
  releaseGate?: DeliveryReleaseGateRef;
  modelSpend?: DeliveryModelSpendRef;
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
const workerFeatureBindingMap: Record<string, string> = {
  'worker-workers-ai': 'AI',
  'worker-d1': 'DB',
  'worker-kv': 'KV',
  'worker-r2': 'ARTIFACTS',
  'worker-workflows': 'PROCESSING_WORKFLOW',
};

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

function scaffoldManifest(output: unknown) {
  return asDeliveryOutput(output).scaffoldManifest;
}

function scaffoldProfiles(output: unknown) {
  return scaffoldManifest(output)?.profileList ?? [];
}

function taskPlanText(output: DeliveryWorkflowScorerOutput) {
  return JSON.stringify(output.taskPlan ?? {});
}

function scaffoldRequiredBindings(output: DeliveryWorkflowScorerOutput) {
  const required = new Set(['ASSETS']);
  for (const profile of output.scaffoldManifest?.profileList ?? []) {
    const binding = workerFeatureBindingMap[profile];
    if (binding) required.add(binding);
  }
  for (const binding of output.sourcePolicy?.externalServiceBindings ?? []) {
    required.add(binding);
  }
  return [...required];
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

export const deliveryScaffoldProfileFitScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-scaffold-profile-fit',
  name: 'Delivery Scaffold Profile Fit',
  description: 'Scores whether the deterministic scaffold profiles fit source policy and Worker-first defaults.',
})
  .generateScore(({ run }) => {
    const output = asDeliveryOutput(run.output);
    const profiles = scaffoldProfiles(run.output);
    if (!profiles.length) return 0;

    const issues = [];
    if (!profiles.some((profile) => profile === 'worker-vanilla-js' || profile === 'worker-typescript')) {
      issues.push('missing Worker language profile');
    }
    if (output.sourcePolicy?.pagesRequired && !profiles.includes('pages-explicit')) {
      issues.push('missing explicit Pages profile');
    }
    if (!output.sourcePolicy?.pagesRequired && profiles.includes('pages-explicit')) {
      issues.push('Pages profile selected without source policy');
    }
    if (output.sourcePolicy?.latestTranscriptRequired && !profiles.includes('worker-d1')) {
      issues.push('latest transcript policy needs D1 profile');
    }

    return issues.length ? 0 : 1;
  })
  .generateReason(({ run, score }) => {
    const output = asDeliveryOutput(run.output);
    const profiles = scaffoldProfiles(run.output);
    if (!profiles.length) return 'No scaffold manifest profiles were recorded.';
    if (score === 1) return `Scaffold profiles fit source policy: ${profiles.join(', ')}.`;

    const issues = [];
    if (!profiles.some((profile) => profile === 'worker-vanilla-js' || profile === 'worker-typescript')) {
      issues.push('missing Worker language profile');
    }
    if (output.sourcePolicy?.pagesRequired && !profiles.includes('pages-explicit')) issues.push('missing pages-explicit');
    if (!output.sourcePolicy?.pagesRequired && profiles.includes('pages-explicit')) issues.push('unexpected pages-explicit');
    if (output.sourcePolicy?.latestTranscriptRequired && !profiles.includes('worker-d1')) issues.push('missing worker-d1');
    return `Scaffold profile fit failed: ${issues.join(', ')}.`;
  });

export const deliveryTestRuntimeMatrixScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-test-runtime-matrix',
  name: 'Delivery Test Runtime Matrix',
  description: 'Scores whether scaffold runtime routing keeps Node, Worker, and jsdom tests separated.',
})
  .generateScore(({ run }) => {
    const matrix = scaffoldManifest(run.output)?.testRuntimeMatrix ?? [];
    if (!matrix.length) return 0;

    const includesFor = (runtime: string) =>
      matrix.filter((rule) => rule.runtime === runtime).flatMap((rule) => rule.include ?? []);
    const node = includesFor('node').join('\n');
    const worker = includesFor('worker').join('\n');
    const frontend = includesFor('jsdom').join('\n');
    const hasBroadWorkerGlob = /test\/\*\*\/\*\.test\.\{?/.test(worker) || /test\/\*\*\/\*\.test\.[tj]s/.test(worker);
    const checks = [
      /contracts\.test/.test(node),
      /validation\.test/.test(node),
      /api-routes\.test/.test(worker),
      /worker-smoke\.test/.test(worker),
      /frontend-\*\.test/.test(frontend) || /ui-\*\.test/.test(frontend),
      !hasBroadWorkerGlob,
    ];
    return rounded(checks.filter(Boolean).length / checks.length);
  })
  .generateReason(({ run, score }) => {
    const matrix = scaffoldManifest(run.output)?.testRuntimeMatrix ?? [];
    if (!matrix.length) return 'No scaffold runtime matrix was recorded.';
    if (score === 1) return 'Runtime matrix separates contract/domain, Worker/API, and frontend DOM tests.';
    return `Runtime matrix scored ${score}; inspect scaffold manifest testRuntimeMatrix for missing includes or broad Worker globs.`;
  });

export const deliveryScaffoldBindingsCompletenessScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-scaffold-bindings-completeness',
  name: 'Delivery Scaffold Bindings Completeness',
  description: 'Scores whether scaffold binding map covers selected Cloudflare profiles and source-declared service bindings.',
})
  .generateScore(({ run }) => {
    const output = asDeliveryOutput(run.output);
    const bindingMap = output.scaffoldManifest?.bindingMap ?? {};
    const required = scaffoldRequiredBindings(output);
    if (!required.length) return 0;
    return rounded(required.filter((binding) => bindingMap[binding]).length / required.length);
  })
  .generateReason(({ run, score }) => {
    const output = asDeliveryOutput(run.output);
    const bindingMap = output.scaffoldManifest?.bindingMap ?? {};
    const required = scaffoldRequiredBindings(output);
    const missing = required.filter((binding) => !bindingMap[binding]);
    if (!required.length) return 'No required scaffold bindings could be inferred.';
    if (!missing.length) return `Scaffold binding map covers required bindings: ${required.join(', ')}.`;
    return `Scaffold binding completeness scored ${score}; missing ${missing.join(', ')}.`;
  });

export const deliveryVanillaFrontendComplianceScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-vanilla-frontend-compliance',
  name: 'Delivery Vanilla Frontend Compliance',
  description: 'Scores whether generated and planned frontend surfaces stay vanilla HTML, CSS, and JavaScript.',
})
  .generateScore(({ run }) => {
    const output = asDeliveryOutput(run.output);
    const files = output.scaffoldManifest?.generatedFiles ?? [];
    const hasVanillaShell = ['public/index.html', 'public/styles.css', 'public/app.js'].every((file) => files.includes(file));
    const packageScripts = output.scaffoldManifest?.packageScripts ?? {};
    const text = taskPlanText(output);
    const introducesFramework = /\b(?:react|vite|next\.js|nextjs|svelte|vue)\b/i.test(text);
    const buildScript = typeof packageScripts.build === 'string' && packageScripts.build.trim().length > 0;
    return hasVanillaShell && !introducesFramework && !buildScript ? 1 : 0;
  })
  .generateReason(({ run, score }) => {
    const output = asDeliveryOutput(run.output);
    if (score === 1) return 'Frontend stays on vanilla public HTML, CSS, and JavaScript with no framework build script.';
    const issues = [];
    const files = output.scaffoldManifest?.generatedFiles ?? [];
    for (const file of ['public/index.html', 'public/styles.css', 'public/app.js']) {
      if (!files.includes(file)) issues.push(`missing ${file}`);
    }
    if (/\b(?:react|vite|next\.js|nextjs|svelte|vue)\b/i.test(taskPlanText(output))) issues.push('framework signal in task plan');
    if (output.scaffoldManifest?.packageScripts?.build) issues.push('build script present');
    return `Vanilla frontend compliance failed: ${issues.join(', ') || 'unknown issue'}.`;
  });

export const deliveryLocalEvidenceReadinessScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-local-evidence-readiness',
  name: 'Delivery Local Evidence Readiness',
  description: 'Scores whether local release-gate evidence is ready for the human approval gate.',
})
  .generateScore(({ run }) => {
    const output = asDeliveryOutput(run.output);
    if (!output.releaseGate) return 0;
    if (output.releaseGate.decision !== 'pass') return 0;
    return (output.releaseGate.blockers ?? []).length === 0 ? 1 : 0;
  })
  .generateReason(({ run, score }) => {
    const output = asDeliveryOutput(run.output);
    if (!output.releaseGate) return 'No release gate evidence was recorded.';
    if (score === 1) return 'Local evidence release gate passed with no blockers.';
    return `Local evidence is not ready: decision=${output.releaseGate.decision ?? 'unknown'}, blockers=${(output.releaseGate.blockers ?? []).join(', ') || 'none'}.`;
  });

export const deliveryModelSpendPerCompletedTaskScorer = createScorer<unknown, DeliveryWorkflowScorerOutput>({
  id: 'delivery-model-spend-per-completed-task',
  name: 'Delivery Model Spend Per Completed Task',
  description: 'Scores model token/cost spend per completed task when spend summaries are available.',
})
  .generateScore(({ run }) => {
    const spend = asDeliveryOutput(run.output).modelSpend;
    if (!spend?.completedTasks || spend.completedTasks <= 0) return 0;
    const tokenScore = spend.totalTokens && spend.maxTokensPerTask
      ? Math.min(1, spend.maxTokensPerTask / (spend.totalTokens / spend.completedTasks))
      : 1;
    const costScore = spend.totalCostUsd && spend.maxCostPerTaskUsd
      ? Math.min(1, spend.maxCostPerTaskUsd / (spend.totalCostUsd / spend.completedTasks))
      : 1;
    return rounded(Math.min(tokenScore, costScore));
  })
  .generateReason(({ run, score }) => {
    const spend = asDeliveryOutput(run.output).modelSpend;
    if (!spend?.completedTasks || spend.completedTasks <= 0) return 'No model spend summary with completed task count was recorded.';
    const tokensPerTask = spend.totalTokens ? rounded(spend.totalTokens / spend.completedTasks) : undefined;
    const costPerTask = spend.totalCostUsd ? rounded(spend.totalCostUsd / spend.completedTasks) : undefined;
    return `Model spend score ${score}; tokens/task=${tokensPerTask ?? 'unknown'}, cost/task=${costPerTask ?? 'unknown'}.`;
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
  deliveryScaffoldProfileFitScorer,
  deliveryTestRuntimeMatrixScorer,
  deliveryScaffoldBindingsCompletenessScorer,
  deliveryVanillaFrontendComplianceScorer,
  deliveryLocalEvidenceReadinessScorer,
  deliveryModelSpendPerCompletedTaskScorer,
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

export const deliveryScaffoldStepScorers: MastraScorers = {
  scaffoldProfileFit: {
    scorer: deliveryScaffoldProfileFitScorer,
    sampling: scoreEveryRun,
  },
  testRuntimeMatrix: {
    scorer: deliveryTestRuntimeMatrixScorer,
    sampling: scoreEveryRun,
  },
  scaffoldBindings: {
    scorer: deliveryScaffoldBindingsCompletenessScorer,
    sampling: scoreEveryRun,
  },
  vanillaFrontend: {
    scorer: deliveryVanillaFrontendComplianceScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

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
  localEvidenceReadiness: {
    scorer: deliveryLocalEvidenceReadinessScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};

export const deliveryDeploymentStepScorers: MastraScorers = {
  completion: {
    scorer: deliveryWorkflowCompletionScorer,
    sampling: scoreEveryRun,
  },
  modelSpendPerTask: {
    scorer: deliveryModelSpendPerCompletedTaskScorer,
    sampling: scoreEveryRun,
  },
  ...deliveryQualityStepScorers,
};
