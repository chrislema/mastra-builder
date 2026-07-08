import { compactDiagnostic } from '../agent-runtime/diagnostics';
import type { AggregatedJudgment, DeterministicGateResult } from '../judgment';
import { taskOwnedBoundaryPaths } from '../task-plan-surface-policy';
import type { ImplementationNote, Task } from '../workflow-schemas';

function taskOwnsStatePersistenceSurface(task?: Task) {
  if (!task) return true;
  return taskOwnedBoundaryPaths(task).some(
    (path) =>
      path.startsWith('migrations/') ||
      path.startsWith('src/storage/') ||
      path.startsWith('src/workflows/') ||
      /\bdurable|do-state|state-store\b/i.test(path),
  );
}

function weakDimensionIsNonActionableForTask(
  dimension: AggregatedJudgment['dimensions_scored'][number],
  task?: Task,
) {
  if (dimension.id === 'implementation_note_quality') return true;
  if (dimension.id !== 'state_explicitness') return false;
  if (taskOwnsStatePersistenceSurface(task)) return false;
  return /\b(database|db|d1|sql|schema|table|check constraints?|indexes?|indices)\b/i.test(dimension.evidence);
}

export function implementationWeakDimensionRemediation(judgment: AggregatedJudgment, task?: Task) {
  return judgment.dimensions_scored
    .filter((dimension) => dimension.score <= 3)
    .filter((dimension) => !weakDimensionIsNonActionableForTask(dimension, task))
    .map(
      (dimension) =>
        `DIMENSION ${dimension.id} scored ${dimension.score}/5. Improve this before continuing: ${compactDiagnostic(
          dimension.evidence,
          500,
        )}`,
    );
}

export function implementationActionableJudgmentRemediation(judgment: AggregatedJudgment, task?: Task) {
  const nonActionableDimensionIds = new Set(
    judgment.dimensions_scored
      .filter((dimension) => dimension.score <= 3)
      .filter((dimension) => weakDimensionIsNonActionableForTask(dimension, task))
      .map((dimension) => dimension.id),
  );

  return judgment.remediation.filter((item) => {
    for (const dimensionId of nonActionableDimensionIds) {
      if (item.startsWith(`DIMENSION ${dimensionId} `)) return false;
    }
    return true;
  });
}

export function implementationFindingSteps(taskId: string, judgment: AggregatedJudgment, task?: Task) {
  const remediation = [
    ...implementationActionableJudgmentRemediation(judgment, task),
    ...implementationWeakDimensionRemediation(judgment, task),
  ];
  return remediation.length ? remediation : [`${taskId} did not produce a passing implementation judgment`];
}

export function shouldProceedAfterNonActionableImplementationJudgment({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed) return false;
  if (judgment.gates_failed.length || judgment.dimensions_missing.length) return false;
  if (implementationActionableJudgmentRemediation(judgment, task).length) return false;
  if (implementationWeakDimensionRemediation(judgment, task).length) return false;
  if (!deterministicResults.every((result) => result.passed)) return false;
  if (!note.verification.performed.length) return false;
  if (note.verification.missing.some((item) => /\bfailed:/i.test(item))) return false;
  return true;
}

export function implementationJudgmentCanComplete({
  judgment,
  deterministicResults,
  note,
  task,
}: {
  judgment: AggregatedJudgment;
  deterministicResults: DeterministicGateResult[];
  note: ImplementationNote;
  task?: Task;
}) {
  if (judgment.passed && !judgment.gates_failed.length && !judgment.dimensions_missing.length) return true;
  return shouldProceedAfterNonActionableImplementationJudgment({ judgment, deterministicResults, note, task });
}
