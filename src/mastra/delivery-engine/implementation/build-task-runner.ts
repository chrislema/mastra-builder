import type { z } from 'zod';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  readDeliveryEventsState,
  recordDeliveryArtifactState,
  startDeliveryStageState,
  updateDeliveryTaskState,
} from '../state-service';
import { writeDeliveryArtifact } from '../state';
import { createDeliveryControlRequestContext } from '../context';
import { deliveryRunMemory } from '../memory';
import type { DeterministicGateResult } from '../judgment';
import { judgeDeliveryArtifact } from '../agent-runtime/judge-runtime';
import {
  deliveryAgentTimeouts,
  preWriteReadBudgetBlockLimit,
  requiredAgent,
} from '../agent-runtime/options';
import {
  DeliveryNoToolCallTimeoutError,
  DeliveryReadBudgetExceededError,
  DeliveryStageTimeoutError,
  latestStageSuccessfulWriteTimestamp,
  runWithDeliveryStageTimeout,
  stageHasToolUse,
  stageReadBudgetBlockedToolCount,
} from '../agent-runtime/stage-timeout';
import { serializeAgentResponse, writeStageTraceArtifact } from '../agent-runtime/trace-artifacts';
import { repoFileContents } from '../repo-files';
import { runBuildVerification } from '../evidence/build-verification';
import type { buildTaskAttemptStateSchema, CheckSummary, Task } from '../workflow-schemas';
import {
  createMissingOwnedSurfaceStubs,
  generatedTaskSurfacePaths,
  missingOwnedSurfacePaths,
  taskSourceBoundarySurfaces,
  unreplacedPreflightStubPaths,
} from './task-boundaries';
import {
  buildTimeoutRemediation,
  canSalvageTimedOutBuildAttempt,
  implementationEnginePolicyMismatch,
  implementationJudgeRepairRemediation,
  implementationJudgeTimeoutRemediation,
  judgeRepairAlreadyAttempted,
} from './retry-runtime';
import {
  implementationFindingSteps,
  implementationJudgmentCanComplete,
} from './judgment-policy';
import {
  implementationDeterministicRemediation,
  implementationDeterministicResults,
  synthesizeImplementationNote,
} from './evidence';
import { buildImplementationAttemptPrompt } from './attempt-prompt';

type BuildTaskAttemptState = z.infer<typeof buildTaskAttemptStateSchema>;

const buildRoleForTask = (task: Task) => (task.owner === 'designer' ? 'designer' : 'engineer') as 'designer' | 'engineer';

const checkSummaries = (results: DeterministicGateResult[], suffix?: string): CheckSummary[] =>
  results.map((result) => ({
    check: suffix
      ? `${result.check ?? result.id ?? 'deterministic_check'}:${suffix}`
      : result.check ?? result.id ?? 'deterministic_check',
    passed: result.passed,
    reason: result.reason ?? 'no reason recorded',
  }));

export async function runBuildTaskAttempt({
  inputData,
  mastra,
  scaffoldManifestSummary,
}: {
  inputData: BuildTaskAttemptState;
  mastra: any;
  scaffoldManifestSummary: unknown;
}) {
  if (inputData.terminal) return inputData;
  if (!inputData.taskPlan) throw new Error('build task attempt did not include a task plan');
  if (!inputData.task) throw new Error('build task attempt did not include a task');

  const taskPlan = inputData.taskPlan;
  const task = inputData.task;
  const artifacts = [...inputData.artifacts];
  const checks = [...inputData.checks];
  const judgments = [...inputData.judgments];
  const role = buildRoleForTask(task);
  const agent = requiredAgent(mastra, role);
  const attempt = inputData.attempt;
  const attemptNumber = attempt + 1;
  const stage = `build:${task.id}`;
  const sourceBoundarySurfaces = taskSourceBoundarySurfaces(inputData.repoPath, task).filter(
    (surface) => !/^unknown\b/i.test(surface),
  );
  const generatedSurfaces = generatedTaskSurfacePaths(task);
  await updateDeliveryTaskState({
    repoPath: inputData.repoPath,
    id: task.id,
    status: 'building',
    owner: role,
    note: attempt > 0 ? `retry ${attemptNumber}` : undefined,
    bumpRetries: attempt > 0,
    mastra,
  });
  await startDeliveryBuildStage({
    repoPath: inputData.repoPath,
    stage,
    role,
    sourceBoundarySurfaces,
    mastra,
  });

  const preflightCreatedSurfaces = await createMissingOwnedSurfaceStubs({
    repoPath: inputData.repoPath,
    task,
    stage,
    mastra,
  });
  const {
    retryMode,
    verificationRecovery,
    focusedRepairRecovery,
    activeTools,
    toolChoice,
    maxSteps,
    finalBuildPrompt,
    postWriteQuietTimeoutMs,
  } = buildImplementationAttemptPrompt({
    repoPath: inputData.repoPath,
    taskPlan,
    task,
    scaffoldManifest: inputData.scaffoldManifest,
    scaffoldManifestSummary,
    sourcePolicy: inputData.sourcePolicy,
    maxRetries: inputData.maxRetries,
    remediation: inputData.remediation,
    sourceBoundarySurfaces,
    generatedSurfaces,
    preflightCreatedSurfaces,
  });
  let buildResponse: unknown;
  try {
    buildResponse = await runWithDeliveryStageTimeout({
      repoPath: inputData.repoPath,
      mastra,
      stage,
      timeoutMs: deliveryAgentTimeouts.build,
      firstToolTimeoutMs: deliveryAgentTimeouts.buildNoTool,
      firstToolCheck: () => stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage }),
      postWriteQuietTimeoutMs,
      latestWriteCheck: () => latestStageSuccessfulWriteTimestamp({ repoPath: inputData.repoPath, mastra, stage }),
      readBudgetBlockLimit: preWriteReadBudgetBlockLimit,
      readBudgetBlockCheck: () => stageReadBudgetBlockedToolCount({ repoPath: inputData.repoPath, mastra, stage }),
      operation: (abortSignal) =>
        agent.generate(
          finalBuildPrompt,
          {
            abortSignal,
            activeTools,
            toolChoice,
            maxSteps,
            toolCallConcurrency: 1,
            memory: deliveryRunMemory({ repoPath: inputData.repoPath, runId: inputData.runId, role: task.owner }),
            requestContext: createDeliveryControlRequestContext(inputData.repoPath),
          },
        ),
    });
  } catch (error) {
    if (!(error instanceof DeliveryStageTimeoutError)) throw error;

    const missingSurfacesAfterTimeout = missingOwnedSurfacePaths(inputData.repoPath, task);
    const unreplacedStubsAfterTimeout = unreplacedPreflightStubPaths(inputData.repoPath, task);
    const stageHadToolUse = await stageHasToolUse({ repoPath: inputData.repoPath, mastra, stage });
    if (
      canSalvageTimedOutBuildAttempt({
        stageHadToolUse,
        missingSurfaces: missingSurfacesAfterTimeout,
        unreplacedStubs: unreplacedStubsAfterTimeout,
      })
    ) {
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'build_timeout_salvaged',
          stage,
          ok: true,
          task: task.id,
          attempt: attemptNumber,
          timeout_ms: error.timeoutMs,
          reason:
            'Build attempt timed out after file edits, but owned surfaces are present and preflight stubs are replaced; running workflow verification instead of marking stuck.',
        },
      });
      await startDeliveryBuildStage({
        repoPath: inputData.repoPath,
        stage,
        role,
        sourceBoundarySurfaces,
        mastra,
      });
      buildResponse = {
        text: `Build attempt timed out after ${error.timeoutMs}ms after making file changes; workflow recovered by running verification against the edited boundary surfaces.`,
        finishReason: 'timeout-salvaged',
      };
    } else {
      const remediation = buildTimeoutRemediation({
        task,
        timeoutMs: error.timeoutMs,
        missingSurfaces: missingSurfacesAfterTimeout,
        repairRecovery: focusedRepairRecovery || verificationRecovery,
        noToolCall: error instanceof DeliveryNoToolCallTimeoutError,
        readBudgetExceeded: error instanceof DeliveryReadBudgetExceededError,
        priorRemediation: inputData.remediation,
      });
      if (attempt >= inputData.maxRetries) {
        await updateDeliveryTaskState({
          repoPath: inputData.repoPath,
          id: task.id,
          status: 'stuck',
          owner: role,
          note: remediation.join(' | ').slice(0, 300),
          mastra,
        });

        return buildAttemptOutput({
          inputData,
          task,
          taskPlan,
          artifacts,
          checks,
          judgments,
          status: 'stuck',
          summary: `Build task ${task.id} timed out.`,
          nextSteps: remediation,
          taskStatus: 'stuck',
          attempt,
          terminal: true,
          remediation,
        });
      }

      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'building',
        owner: role,
        note: `retry after timeout ${attemptNumber}`,
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'reviewed',
        summary: `Build task ${task.id} timed out and needs another implementation attempt.`,
        nextSteps: remediation,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation,
      });
    }
  }
  const buildTracePath = await writeStageTraceArtifact({
    repoPath: inputData.repoPath,
    mastra,
    artifactType: `trace-build-${task.id}-a${attemptNumber}`,
    artifactPath: `.delivery/artifacts/traces/build-${task.id}-a${attemptNumber}.json`,
    trace: {
      artifact_type: 'agent-turn-trace',
      stage,
      role,
      task: task.id,
      attempt: attemptNumber,
      prompt: finalBuildPrompt,
      response: serializeAgentResponse(buildResponse),
      activeTools,
      toolChoice,
      retryMode,
    },
  });
  artifacts.push(buildTracePath);

  const verification = await runBuildVerification({
    repoPath: inputData.repoPath,
    mastra,
    stage,
    taskPlan,
    taskIndex: inputData.taskIndex,
  });
  const buildEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
  const note = synthesizeImplementationNote({
    repoPath: inputData.repoPath,
    stage,
    task,
    taskPlan,
    events: buildEvents,
    buildResponse,
    verification,
  });
  const notePath = `.delivery/artifacts/note-${task.id}.a${attemptNumber}.json`;
  writeDeliveryArtifact({
    repoPath: inputData.repoPath,
    artifactPath: notePath,
    artifact: note,
  });
  await recordDeliveryArtifactState({
    repoPath: inputData.repoPath,
    type: `note-${task.id}`,
    path: notePath,
    mastra,
  });
  artifacts.push(notePath);

  await endDeliveryStageState({
    repoPath: inputData.repoPath,
    stage,
    reason: 'complete_stage',
    mastra,
  });

  const deliveryEvents = await readDeliveryEventsState({ repoPath: inputData.repoPath, mastra });
  const deterministicResults = implementationDeterministicResults({
    repoPath: inputData.repoPath,
    stage,
    role,
    task,
    note,
    events: deliveryEvents,
    verification,
  });
  checks.push(...checkSummaries(deterministicResults, `${task.id}.a${attemptNumber}`));

  const deterministicRemediation = implementationDeterministicRemediation(deterministicResults);
  if (deterministicRemediation.length) {
    const enginePolicyMismatch = implementationEnginePolicyMismatch({
      repoPath: inputData.repoPath,
      stage,
      role,
      task,
      events: deliveryEvents,
    });
    const staleWorkspaceVerification = deterministicRemediation.filter((item) =>
      /\bSTALE_WORKSPACE_VERIFICATION\b/i.test(item),
    );
    const scaffoldBaselineVerification = deterministicRemediation.filter((item) =>
      /\bSCAFFOLD_BASELINE_VERIFICATION\b/i.test(item),
    );
    await appendDeliveryEventState({
      repoPath: inputData.repoPath,
      mastra,
      event: {
        type: 'implementation_deterministic_blocker',
        stage,
        ok: false,
        task: task.id,
        attempt: attemptNumber,
        remediation: deterministicRemediation,
        engine_policy_mismatch: enginePolicyMismatch,
      },
    });

    if (scaffoldBaselineVerification.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: scaffoldBaselineVerification.join(' | ').slice(0, 300),
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'stuck',
        summary: `Build task ${task.id} stopped because deterministic scaffold verification failed.`,
        nextSteps: scaffoldBaselineVerification,
        taskStatus: 'stuck',
        attempt,
        terminal: true,
        remediation: scaffoldBaselineVerification,
      });
    }

    if (staleWorkspaceVerification.length) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: staleWorkspaceVerification.join(' | ').slice(0, 300),
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'stuck',
        summary: `Build task ${task.id} stopped because repo-wide verification failed outside the current task plan.`,
        nextSteps: staleWorkspaceVerification,
        taskStatus: 'stuck',
        attempt,
        terminal: true,
        remediation: staleWorkspaceVerification,
      });
    }

    if (enginePolicyMismatch.length) {
      const remediation = [...enginePolicyMismatch, ...deterministicRemediation];
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: remediation.join(' | ').slice(0, 300),
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'stuck',
        summary: `Build task ${task.id} stopped on a delivery engine policy mismatch.`,
        nextSteps: remediation,
        taskStatus: 'stuck',
        attempt,
        terminal: true,
        remediation,
      });
    }

    if (attempt >= inputData.maxRetries) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: deterministicRemediation.join(' | ').slice(0, 300),
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'stuck',
        summary: `Build task ${task.id} failed deterministic implementation gates.`,
        nextSteps: deterministicRemediation,
        taskStatus: 'stuck',
        attempt,
        terminal: true,
        remediation: deterministicRemediation,
      });
    }

    return buildAttemptOutput({
      inputData,
      task,
      taskPlan,
      artifacts,
      checks,
      judgments,
      status: 'reviewed',
      summary: `Build task ${task.id} needs another attempt after deterministic implementation gates.`,
      nextSteps: deterministicRemediation,
      taskStatus: undefined,
      attempt: attempt + 1,
      terminal: false,
      remediation: deterministicRemediation,
    });
  }

  let implementationJudge: Awaited<ReturnType<typeof judgeDeliveryArtifact>>;
  try {
    implementationJudge = await judgeDeliveryArtifact({
      mastra,
      repoPath: inputData.repoPath,
      runId: inputData.runId,
      rubricName: 'implementation',
      subjectName: notePath,
      subject: {
        task,
        note,
        files: repoFileContents(inputData.repoPath, note.files_touched),
        task_plan: taskPlan,
      },
      deterministicResults,
      slug: `implementation-${task.id}-a${attemptNumber}`,
    });
  } catch (error) {
    if (!(error instanceof DeliveryStageTimeoutError)) throw error;

    const remediation = implementationJudgeTimeoutRemediation(task.id, attemptNumber, error.timeoutMs);
    if (attempt >= inputData.maxRetries) {
      await updateDeliveryTaskState({
        repoPath: inputData.repoPath,
        id: task.id,
        status: 'stuck',
        owner: role,
        note: remediation.join(' | ').slice(0, 300),
        mastra,
      });

      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'stuck',
        summary: `Build task ${task.id} judgment timed out.`,
        nextSteps: remediation,
        taskStatus: 'stuck',
        attempt,
        terminal: true,
        remediation,
      });
    }

    await updateDeliveryTaskState({
      repoPath: inputData.repoPath,
      id: task.id,
      status: 'building',
      owner: role,
      note: `retry after judge timeout ${attemptNumber}`,
      mastra,
    });

    return buildAttemptOutput({
      inputData,
      task,
      taskPlan,
      artifacts,
      checks,
      judgments,
      status: 'reviewed',
      summary: `Build task ${task.id} judgment timed out and needs another bounded attempt.`,
      nextSteps: remediation,
      taskStatus: undefined,
      attempt: attempt + 1,
      terminal: false,
      remediation,
    });
  }
  artifacts.push(implementationJudge.judgeOutputPath, implementationJudge.judgmentPath, implementationJudge.tracePath);
  judgments.push(implementationJudge.ref);

  if (
    implementationJudgmentCanComplete({
      judgment: implementationJudge.judgment,
      deterministicResults,
      note,
      task,
    })
  ) {
    const acceptedByFastPath = !implementationJudge.judgment.passed;
    if (acceptedByFastPath) {
      const check = {
        check: `non_actionable_implementation_judgment:${task.id}.a${attemptNumber}`,
        passed: true,
        reason: `Implementation judgment scored ${implementationJudge.judgment.overall} without failed gates, failed deterministic checks, or actionable remediation.`,
      };
      checks.push(check);
      await appendDeliveryEventState({
        repoPath: inputData.repoPath,
        mastra,
        event: {
          type: 'implementation_judgment_non_actionable',
          stage,
          ok: true,
          task: task.id,
          attempt: attemptNumber,
          overall: implementationJudge.judgment.overall,
          judgmentPath: implementationJudge.judgmentPath,
        },
      });
    }
    await updateDeliveryTaskState({
      repoPath: inputData.repoPath,
      id: task.id,
      status: 'complete',
      owner: role,
      note: acceptedByFastPath
        ? `accepted non-actionable judgment ${implementationJudge.judgment.overall}`
        : `judged ${implementationJudge.judgment.overall}`,
      mastra,
    });

    return buildAttemptOutput({
      inputData,
      task,
      taskPlan,
      artifacts,
      checks,
      judgments,
      status: 'built',
      summary: acceptedByFastPath
        ? `Build task ${task.id} completed with a non-actionable implementation score recorded for release-gate follow-up.`
        : `Build task ${task.id} completed.`,
      nextSteps: acceptedByFastPath
        ? ['Continue the delivery build loop; release gate should verify any missing acceptance checks.']
        : ['Continue the delivery build loop.'],
      taskStatus: 'complete',
      attempt,
      terminal: true,
      remediation: [],
    });
  }

  const remediation = implementationFindingSteps(task.id, implementationJudge.judgment, task);
  if (attempt >= inputData.maxRetries) {
    if (!judgeRepairAlreadyAttempted(inputData.remediation)) {
      const judgeRepairRemediation = implementationJudgeRepairRemediation(
        implementationJudge.judgmentPath,
        remediation,
      );
      return buildAttemptOutput({
        inputData,
        task,
        taskPlan,
        artifacts,
        checks,
        judgments,
        status: 'reviewed',
        summary: `Build task ${task.id} passed deterministic checks and needs one focused judge repair attempt.`,
        nextSteps: judgeRepairRemediation,
        taskStatus: undefined,
        attempt: attempt + 1,
        terminal: false,
        remediation: judgeRepairRemediation,
      });
    }

    await updateDeliveryTaskState({
      repoPath: inputData.repoPath,
      id: task.id,
      status: 'stuck',
      owner: role,
      note: remediation.join(' | ').slice(0, 300) || 'implementation did not pass judgment',
      mastra,
    });

    return buildAttemptOutput({
      inputData,
      task,
      taskPlan,
      artifacts,
      checks,
      judgments,
      status: 'stuck',
      summary: `Build task ${task.id} did not pass implementation judgment.`,
      nextSteps: remediation,
      taskStatus: 'stuck',
      attempt,
      terminal: true,
      remediation,
    });
  }

  return buildAttemptOutput({
    inputData,
    task,
    taskPlan,
    artifacts,
    checks,
    judgments,
    status: 'reviewed',
    summary: `Build task ${task.id} needs another implementation attempt.`,
    nextSteps: remediation,
    taskStatus: undefined,
    attempt: attempt + 1,
    terminal: false,
    remediation,
  });
}

async function startDeliveryBuildStage({
  repoPath,
  stage,
  role,
  sourceBoundarySurfaces,
  mastra,
}: {
  repoPath: string;
  stage: string;
  role: 'designer' | 'engineer';
  sourceBoundarySurfaces: string[];
  mastra: any;
}) {
  await startDeliveryStageState({
    repoPath,
    stage,
    role,
    surfaces: sourceBoundarySurfaces.length ? sourceBoundarySurfaces : undefined,
    mastra,
  });
}

function buildAttemptOutput({
  inputData,
  task,
  taskPlan,
  artifacts,
  checks,
  judgments,
  status,
  summary,
  nextSteps,
  taskStatus,
  attempt,
  terminal,
  remediation,
}: {
  inputData: BuildTaskAttemptState;
  task: Task;
  taskPlan: NonNullable<BuildTaskAttemptState['taskPlan']>;
  artifacts: BuildTaskAttemptState['artifacts'];
  checks: BuildTaskAttemptState['checks'];
  judgments: BuildTaskAttemptState['judgments'];
  status: 'reviewed' | 'built' | 'stuck';
  summary: string;
  nextSteps: string[];
  taskStatus: 'complete' | 'stuck' | 'blocked' | 'skipped' | undefined;
  attempt: number;
  terminal: boolean;
  remediation: string[];
}) {
  return {
    repoPath: inputData.repoPath,
    maxRetries: inputData.maxRetries,
    deployMode: inputData.deployMode,
    reviewMode: inputData.reviewMode,
    taskPlan,
    releaseGate: inputData.releaseGate,
    status,
    runId: inputData.runId,
    summary,
    artifacts,
    checks,
    judgments,
    questions: [],
    nextSteps,
    task,
    taskIndex: inputData.taskIndex,
    skipped: false,
    taskId: task.id,
    taskStatus,
    attempt,
    terminal,
    remediation,
  };
}
