import { compactDiagnostic } from '../agent-runtime/diagnostics';
import type { AggregatedJudgment, DeterministicGateResult } from '../judgment';
import { parseDeliveryStructuredOutput } from '../structured-output';
import { plannerRevisionOutputSchema, taskPlanSchema } from '../workflow-schemas';

export function parsePlannerRevisionResponse(response: unknown, label: string) {
  try {
    return {
      revision: parseDeliveryStructuredOutput(plannerRevisionOutputSchema, response, label),
      repairedFromBareTaskPlan: false,
    };
  } catch (error) {
    const taskPlan = parseDeliveryStructuredOutput(taskPlanSchema, response, `${label} taskPlan`);
    return {
      revision: { taskPlan },
      repairedFromBareTaskPlan: true,
      repairReason: compactDiagnostic(error),
    };
  }
}

export function planGateRevisionRemediation({
  deterministicResults,
  judgment,
}: {
  deterministicResults: DeterministicGateResult[];
  judgment: AggregatedJudgment;
}) {
  const failedChecks = deterministicResults.filter((check) => !check.passed);
  if (failedChecks.length) {
    return failedChecks.map((check) => check.reason ?? 'deterministic task-plan check failed');
  }
  if (!judgment.passed) return judgment.remediation;
  return [];
}
