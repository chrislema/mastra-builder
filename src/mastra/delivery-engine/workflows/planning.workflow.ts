import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  initializeDeliveryRunState,
  recordDeliveryArtifactState,
  startDeliveryStageState,
} from '../state-service';
import { writeDeliveryArtifact } from '../state';
import { normalizeDeliveryPathReference } from '../checks';
import {
  createDeliveryControlRequestContext,
  createDeliveryRequestContext,
} from '../context';
import { deliveryRunMemory } from '../memory';
import type { AggregatedJudgment, DeterministicGateResult } from '../judgment';
import { deliveryPlanStepScorers } from '../scorers';
import { safePersistDeliveryStateWithMastra } from '../observability';
import { deliveryStructuredOutputOptions } from '../models';
import { parseDeliveryStructuredOutput } from '../structured-output';
import {
  deliveryWorkflowInputSchema,
  normalizeDeliveryWorkflowInput,
} from '../run-input';
import { markDeliveryRunFailedOnWorkflowError } from '../workflow-support/errors';
import {
  syncDeliveryWorkflowState,
  syncPlanStateStep,
} from '../workflow-support/state-sync';
import { judgeDeliveryArtifact } from '../agent-runtime/judge-runtime';
import {
  deliveryAgentTimeouts,
  requiredAgent,
  structuredNoToolOptions,
} from '../agent-runtime/options';
import { runWithDeliveryStageTimeout } from '../agent-runtime/stage-timeout';
import {
  normalizeReadoutSafeAdapterAmbiguities,
  openDecisionHygiene,
  shouldSuspendForPlannerQuestions,
} from '../planning/readout-policy';
import {
  preserveTaskPlanAcceptanceContracts,
  taskPlanAcceptanceContractRegression,
} from '../planning/acceptance-contract-preservation';
import { generatedSliceDependencyHygiene } from '../planning/generated-slice-policy';
import { taskPlanDeterministicResults } from '../planning/task-plan-gates';
import { pagesFunctionsExceptionHygiene } from '../planning/pages-policy';
import { ownedSurfaceHygiene } from '../planning/owned-surface-policy';
import { taskOwnedSurfaceRoleHygiene } from '../planning/role-boundary-policy';
import { configSchemaTaskSplitHygiene } from '../planning/config-schema-policy';
import { operatorDocumentationHygiene } from '../planning/operator-documentation-policy';
import { normalizeTaskPlanForDelivery } from '../planning/task-plan-normalizer';
import {
  parsePlannerRevisionResponse,
  planGateRevisionRemediation,
} from '../planning/task-plan-revision';
import { projectScaffoldHygiene } from '../planning/scaffold-policy';
import { currentWorkerCompatibilityDate } from '../implementation/task-boundaries';
import { repoFileContents } from '../repo-files';
import {
  deliveryStageOutputSchema,
  deliveryWorkflowStateSchema,
  initializedSchema,
  plannerArtifactsSchema,
  plannerCacheSchema,
  plannerOutputSchema,
  plannerQuestionsResumeSchema,
  plannerQuestionsSuspendSchema,
  plannerRevisionOutputSchema,
  planStageOutputSchema,
  readoutSchema,
  taskPlanSchema,
  type CheckSummary,
  type JudgmentRef,
  type SourcePolicy,
  type TaskPlan,
} from '../workflow-schemas';
import {
  sourcePolicyFromDocuments,
  sourcePolicyFromRepo,
} from '../source-policy';
import {
  initialPlannerPrompt,
  planGateRevisionPrompt,
} from '../planner-prompt-policy';

const plannerPolicyVersion = 'worker-first-local-v17';

function plannerSourceFingerprint(sourceDocuments: Array<{ path: string; content: string }>) {
  return createHash('sha256').update(JSON.stringify(sourceDocuments)).digest('hex');
}

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  if (!existsSync(fullPath)) return undefined;
  return JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
}

function readCachedPlannerOutput({
  repoPath,
  sourceFingerprint,
  sourcePolicy,
}: {
  repoPath: string;
  sourceFingerprint: string;
  sourcePolicy: SourcePolicy;
}) {
  if (process.env.DELIVERY_REUSE_PLAN_CACHE === '0') return undefined;

  const readout = readoutSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/readout.json'));
  const taskPlan = taskPlanSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/task-plan.json'));
  if (!readout.success || !taskPlan.success) return undefined;

  const cache = plannerCacheSchema.safeParse(readJsonArtifact(repoPath, '.delivery/artifacts/plan-cache.json'));
  if (cache.success && cache.data.sourceFingerprint !== sourceFingerprint) return undefined;
  if (cache.success && cache.data.policyVersion !== plannerPolicyVersion) return undefined;
  if (!openDecisionHygiene(taskPlan.data).passed) return undefined;
  if (!ownedSurfaceHygiene(taskPlan.data).passed) return undefined;
  if (!taskOwnedSurfaceRoleHygiene(taskPlan.data).passed) return undefined;
  if (!pagesFunctionsExceptionHygiene(taskPlan.data, sourcePolicy).passed) return undefined;
  if (!projectScaffoldHygiene(repoPath, taskPlan.data).passed) return undefined;
  if (!configSchemaTaskSplitHygiene(taskPlan.data).passed) return undefined;
  if (!operatorDocumentationHygiene(taskPlan.data).passed) return undefined;
  if (!generatedSliceDependencyHygiene(taskPlan.data).passed) return undefined;

  return { readout: readout.data, taskPlan: taskPlan.data, cacheValidated: cache.success };
}

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((check) => ({
    check: `${check.check ?? check.id ?? 'unknown'}${suffix ? `:${suffix}` : ''}`,
    passed: check.passed,
    reason: check.reason ?? 'deterministic check',
  }));

const initializeRunStep = createStep({
  id: 'initialize-delivery-run',
  description: 'Create delivery run state, export .delivery files, and persist the initial snapshot.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: initializedSchema,
  stateSchema: deliveryWorkflowStateSchema,
  execute: async ({ inputData, state, setState, mastra }) => {
    const workflowInput = normalizeDeliveryWorkflowInput(inputData);
    const run = await initializeDeliveryRunState({ ...workflowInput, mastra });
    const repoPath = resolve(workflowInput.repoPath);
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath,
        runId: run.run_id,
        maxRetries: workflowInput.maxRetries,
        deployMode: workflowInput.deployMode,
        reviewMode: workflowInput.reviewMode,
        artifacts: [],
        checks: [],
        judgments: [],
        questions: [],
        nextSteps: [],
      },
    });
    await safePersistDeliveryStateWithMastra({ repoPath, mastra });

    return {
      ...workflowInput,
      repoPath,
      visionPath: run.vision,
      specPath: run.spec,
      runId: run.run_id,
      reviewMode: workflowInput.reviewMode,
    };
  },
});

const createPlannerArtifactsStep = createStep({
  id: 'create-planner-artifacts',
  description: 'Use the planner agent to create readout and task-plan artifacts.',
  inputSchema: initializedSchema,
  outputSchema: plannerArtifactsSchema,
  stateSchema: deliveryWorkflowStateSchema,
  resumeSchema: plannerQuestionsResumeSchema,
  suspendSchema: plannerQuestionsSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, state, setState }) => {
    await startDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      role: 'planner',
      mastra,
    });

    const planner = requiredAgent(mastra, 'planner');
    const humanAnswers = resumeData
      ? `\nHuman answers to prior blocking questions:\n${resumeData.answers
          .map((answer) => `- Q: ${answer.question}\n  A: ${answer.answer}`)
          .join('\n')}${resumeData.notes ? `\nAdditional notes: ${resumeData.notes}` : ''}\n`
      : '';
    const sourceDocuments = repoFileContents(inputData.repoPath, [inputData.visionPath, inputData.specPath]);
    const loadedVision = sourceDocuments.some(
      (document) => document.path === normalizeDeliveryPathReference(inputData.visionPath),
    );
    const normalizedSpecPath = inputData.specPath ? normalizeDeliveryPathReference(inputData.specPath) : undefined;
    const loadedSpec =
      !inputData.specPath ||
      sourceDocuments.some((document) => document.path === normalizedSpecPath);
    if (!loadedVision) {
      throw new Error(`planner could not load required vision document ${inputData.visionPath}`);
    }
    if (!loadedSpec) {
      throw new Error(`planner could not load spec document ${inputData.specPath}`);
    }
    const repoScaffoldState = {
      packageJson: existsSync(join(inputData.repoPath, 'package.json')) ? 'present' : 'missing',
      tsconfigJson: existsSync(join(inputData.repoPath, 'tsconfig.json')) ? 'present' : 'missing',
    } as const;
    const sourceFingerprint = plannerSourceFingerprint(sourceDocuments);
    const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
    const cachedOutput = readCachedPlannerOutput({
      repoPath: inputData.repoPath,
      sourceFingerprint,
      sourcePolicy,
    });

    const output = cachedOutput
      ? { readout: cachedOutput.readout, taskPlan: cachedOutput.taskPlan }
      : parseDeliveryStructuredOutput(
          plannerOutputSchema,
          await runWithDeliveryStageTimeout({
            repoPath: inputData.repoPath,
            mastra,
            stage: 'plan',
            timeoutMs: deliveryAgentTimeouts.standard,
            operation: (abortSignal) =>
              planner.generate(
                initialPlannerPrompt({
                  sourceDocuments,
                  sourcePolicy,
                  repoScaffoldState,
                  compatibilityDate: currentWorkerCompatibilityDate(),
                  hasSpecPath: Boolean(inputData.specPath),
                  humanAnswers,
                }),
                {
                  ...structuredNoToolOptions,
                  abortSignal,
                  memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: 'planner' }),
                  requestContext: createDeliveryRequestContext(inputData.repoPath),
                  structuredOutput: {
                    schema: plannerOutputSchema,
                    ...deliveryStructuredOutputOptions,
                    instructions: 'Return only the structured readout and taskPlan objects.',
                  },
                },
              ),
          }),
          'planner',
        );
    output.readout = normalizeReadoutSafeAdapterAmbiguities(output.readout);
    output.taskPlan = normalizeTaskPlanForDelivery(inputData.repoPath, output.taskPlan);

    if (cachedOutput) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'planner_cache_reused',
          stage: 'plan',
          cache_validated: cachedOutput.cacheValidated,
        },
      });
    } else {
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/readout.json',
        artifact: output.readout,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/task-plan.json',
        artifact: output.taskPlan,
      });
      writeDeliveryArtifact({
        repoPath: inputData.repoPath,
        artifactPath: '.delivery/artifacts/plan-cache.json',
        artifact: {
          sourceFingerprint,
          policyVersion: plannerPolicyVersion,
          createdAt: new Date().toISOString(),
        },
      });
    }

    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'readout',
      path: '.delivery/artifacts/readout.json',
      mastra,
    });
    await recordDeliveryArtifactState({
      repoPath: inputData.repoPath,
      type: 'task-plan',
      path: '.delivery/artifacts/task-plan.json',
      mastra,
    });

    const suspendForQuestions = shouldSuspendForPlannerQuestions(output.readout, output.taskPlan);
    await endDeliveryStageState({
      repoPath: inputData.repoPath,
      stage: 'plan',
      reason: suspendForQuestions ? 'escalation' : 'complete_stage',
      mastra,
    });

    if (output.readout.blocking_ambiguities.length) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: suspendForQuestions ? 'human_input_required' : 'planning_questions_deferred',
          stage: 'plan',
          questions: output.readout.blocking_ambiguities,
        },
      });
    }

    if (suspendForQuestions) {
      await syncDeliveryWorkflowState({
        state,
        setState,
        output: {
          repoPath: inputData.repoPath,
          runId: inputData.runId,
          maxRetries: inputData.maxRetries,
          deployMode: inputData.deployMode,
          status: 'blocked_on_questions',
          summary: output.readout.recommended_next_step,
          artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
          sourcePolicy,
          questions: output.readout.blocking_ambiguities,
          nextSteps: ['Answer the blocking questions, then resume delivery planning.'],
          taskPlan: output.taskPlan,
        },
      });

      return await suspend(
        {
          reason: 'Planner found blocking ambiguities that require human answers before plan judgment.',
          questions: output.readout.blocking_ambiguities,
          recommendedNextStep: output.readout.recommended_next_step,
          readoutPath: '.delivery/artifacts/readout.json',
          taskPlanPath: '.delivery/artifacts/task-plan.json',
        },
        { resumeLabel: 'answer-planner-questions' },
      );
    }

    const plannerOutput = {
      ...inputData,
      readout: output.readout,
      taskPlan: output.taskPlan,
      artifacts: ['.delivery/artifacts/readout.json', '.delivery/artifacts/task-plan.json'],
      sourcePolicy,
    };
    await syncDeliveryWorkflowState({
      state,
      setState,
      output: {
        repoPath: plannerOutput.repoPath,
        runId: plannerOutput.runId,
        maxRetries: plannerOutput.maxRetries,
        deployMode: plannerOutput.deployMode,
        reviewMode: plannerOutput.reviewMode,
        artifacts: plannerOutput.artifacts,
        sourcePolicy: plannerOutput.sourcePolicy,
        taskPlan: plannerOutput.taskPlan,
        questions: output.readout.blocking_ambiguities,
      },
    });

    return plannerOutput;
  },
});

async function reviseTaskPlanFromPlanGate({
  mastra,
  repoPath,
  runId,
  taskPlan,
  deterministicResults,
  judgment,
  revisionNumber,
}: {
  mastra: any;
  repoPath: string;
  runId: string;
  taskPlan: TaskPlan;
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
  revisionNumber: number;
}) {
  const stage = `plan:gate-repair-${revisionNumber}`;
  const revisionPath = `.delivery/artifacts/task-plan.plan-gate-revision-${revisionNumber}.json`;
  const remediation = planGateRevisionRemediation({ deterministicResults, judgment });
  const sourcePolicy = sourcePolicyFromRepo(repoPath);

  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'plan_gate_revision_requested',
      stage,
      revision: String(revisionNumber),
      remediation,
    },
  });
  await startDeliveryStageState({
    repoPath,
    stage,
    role: 'planner',
    mastra,
  });

  const planner = requiredAgent(mastra, 'planner');
  let response: unknown;
  try {
    response = await runWithDeliveryStageTimeout({
      repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.standard,
      operation: (abortSignal) =>
        planner.generate(
          planGateRevisionPrompt({
            taskPlan,
            deterministicResults,
            judgment,
            remediation,
            sourcePolicy,
            compatibilityDate: currentWorkerCompatibilityDate(),
          }),
          {
            ...structuredNoToolOptions,
            abortSignal,
            memory: deliveryRunMemory({ repoPath, runId, role: 'planner' }),
            requestContext: createDeliveryControlRequestContext(repoPath),
            structuredOutput: {
              schema: plannerRevisionOutputSchema,
              ...deliveryStructuredOutputOptions,
              instructions: 'Return only the revised taskPlan object wrapped as { "taskPlan": ... }.',
            },
          },
        ),
    });
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }

  let parsedRevision: ReturnType<typeof parsePlannerRevisionResponse>;
  try {
    parsedRevision = parsePlannerRevisionResponse(response, `plan gate revision ${revisionNumber}`);
  } catch (error) {
    await endDeliveryStageState({ repoPath, stage, reason: 'failed', mastra }).catch(() => undefined);
    throw error;
  }
  if (parsedRevision.repairedFromBareTaskPlan) {
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'structured_output_repaired',
        stage,
        target: 'task-plan',
        reason: parsedRevision.repairReason,
      },
    });
  }

  const { taskPlan: revisedTaskPlan } = preserveTaskPlanAcceptanceContracts(
    taskPlan,
    normalizeTaskPlanForDelivery(repoPath, parsedRevision.revision.taskPlan),
  );
  writeDeliveryArtifact({
    repoPath,
    artifactPath: revisionPath,
    artifact: revisedTaskPlan,
  });
  writeDeliveryArtifact({
    repoPath,
    artifactPath: '.delivery/artifacts/task-plan.json',
    artifact: revisedTaskPlan,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: `task-plan:plan-gate-revision-${revisionNumber}`,
    path: revisionPath,
    mastra,
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: 'task-plan',
    path: '.delivery/artifacts/task-plan.json',
    mastra,
  });
  await endDeliveryStageState({ repoPath, stage, reason: 'complete_stage', mastra });

  return {
    taskPlan: revisedTaskPlan,
    path: revisionPath,
  };
}

const createPlanGateStep = createStep({
  id: 'judge-task-plan',
  description: 'Run deterministic plan gates and rubric judgment before architect handoff.',
  inputSchema: plannerArtifactsSchema,
  outputSchema: planStageOutputSchema,
  scorers: deliveryPlanStepScorers,
  execute: async ({ inputData, mastra }) => {
    const artifacts = [...inputData.artifacts];
    const checks: CheckSummary[] = [];
    const judgments: JudgmentRef[] = [];
    let taskPlan = inputData.taskPlan;
    let subjectName = '.delivery/artifacts/task-plan.json';

    for (let attempt = 0; attempt <= inputData.maxRetries; attempt += 1) {
      const suffix = attempt === 0 ? undefined : `plan-gate-revision-${attempt}`;
      const deterministicResults = taskPlanDeterministicResults({
        repoPath: inputData.repoPath,
        taskPlan,
        sourcePolicy: inputData.sourcePolicy,
      });
      checks.push(...checkSummaries(deterministicResults, suffix));
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'deterministic_gate_result',
          stage: suffix ? `plan-gate:${suffix}` : 'plan-gate',
          gate: 'task-plan',
          passed: deterministicResults.every((result) => result.passed),
          checks: deterministicResults.map((result) => ({
            id: result.id,
            check: result.check,
            passed: result.passed,
            reason: result.reason,
          })),
        },
      }).catch(() => undefined);
      const taskPlanJudge = await judgeDeliveryArtifact({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        rubricName: 'task-plan',
        subjectName,
        subject: taskPlan,
        deterministicResults,
        slug: attempt === 0 ? 'task-plan' : `task-plan-plan-gate-revision-${attempt}`,
      });
      const taskPlanJudgment = taskPlanJudge.judgment;
      artifacts.push(taskPlanJudge.judgeOutputPath, taskPlanJudge.judgmentPath);
      judgments.push(taskPlanJudge.ref);

      const planContext = {
        repoPath: inputData.repoPath,
        maxRetries: inputData.maxRetries,
        deployMode: inputData.deployMode,
        reviewMode: inputData.reviewMode,
        sourcePolicy: inputData.sourcePolicy,
        taskPlan,
      };

      if (shouldSuspendForPlannerQuestions(inputData.readout, taskPlan)) {
        return {
          ...planContext,
          status: 'blocked_on_questions' as const,
          runId: inputData.runId,
          summary: inputData.readout.recommended_next_step,
          artifacts,
          checks,
          judgments,
          questions: inputData.readout.blocking_ambiguities,
          nextSteps: ['Answer the blocking questions, then rerun or resume delivery planning.'],
        };
      }

      const remediation = planGateRevisionRemediation({ deterministicResults, judgment: taskPlanJudgment });
      if (!remediation.length) {
        return {
          ...planContext,
          status: 'planned' as const,
          runId: inputData.runId,
          summary: taskPlan.scope,
          artifacts,
          checks,
          judgments,
          questions: inputData.readout.blocking_ambiguities,
          nextSteps: [
            ...inputData.readout.blocking_ambiguities.map((question) => `Deferred question: ${question}`),
            `Run architecture review against ${subjectName}.`,
            'Continue through the native architect review, build, release-gate, and deployment stages.',
          ],
        };
      }

      if (attempt >= inputData.maxRetries) {
        const deterministicFailed = deterministicResults.some((check) => !check.passed);
        return {
          ...planContext,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: deterministicFailed
            ? 'Planner produced artifacts, but deterministic plan checks failed after repair attempts.'
            : 'Planner produced artifacts, but the task-plan rubric judgment failed after repair attempts.',
          artifacts,
          checks,
          judgments,
          questions: [],
          nextSteps: remediation,
        };
      }

      const revision = await reviseTaskPlanFromPlanGate({
        mastra,
        repoPath: inputData.repoPath,
        runId: inputData.runId,
        taskPlan,
        deterministicResults,
        judgment: taskPlanJudgment,
        revisionNumber: attempt + 1,
      });
      const regression = taskPlanAcceptanceContractRegression(taskPlan, revision.taskPlan);
      checks.push(...checkSummaries([{ id: 'acceptance_contracts_preserved', check: 'task_plan_acceptance_contract_regression', ...regression }], `plan-gate-revision-${attempt + 1}`));
      if (!regression.passed) {
        return {
          ...planContext,
          taskPlan: revision.taskPlan,
          status: 'stuck' as const,
          runId: inputData.runId,
          summary: 'Planner revision dropped acceptance criteria from the prior task plan.',
          artifacts: [...artifacts, revision.path],
          checks,
          judgments,
          questions: [],
          nextSteps: [regression.reason],
        };
      }
      taskPlan = revision.taskPlan;
      subjectName = revision.path;
      artifacts.push(revision.path);
    }

    return {
      repoPath: inputData.repoPath,
      maxRetries: inputData.maxRetries,
      deployMode: inputData.deployMode,
      reviewMode: inputData.reviewMode,
      taskPlan,
      status: 'stuck' as const,
      runId: inputData.runId,
      summary: 'Planner could not produce a task plan before the retry budget ended.',
      artifacts,
      checks,
      judgments,
      questions: [],
      nextSteps: ['Inspect the plan-gate judgments and task-plan revision artifacts.'],
    };
  },
});

export const deliveryPlanningWorkflow = createWorkflow({
  id: 'delivery-planning',
  description: 'Plan a delivery run, repair the task plan, and persist the plan-stage state.',
  inputSchema: deliveryWorkflowInputSchema,
  outputSchema: deliveryStageOutputSchema,
  stateSchema: deliveryWorkflowStateSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(initializeRunStep)
  .then(createPlannerArtifactsStep)
  .then(createPlanGateStep)
  .then(syncPlanStateStep)
  .commit();
