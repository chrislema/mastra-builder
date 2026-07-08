import { runDeterministicCheck, type DeliveryEvent } from '../checks';
import type { DeterministicGateResult } from '../judgment';
import type { DeploymentReport, ReleaseGate } from '../workflow-schemas';

export function deploymentDeterministicResults({
  stage,
  releaseGate,
  events,
}: {
  stage: string;
  releaseGate: ReleaseGate;
  events: DeliveryEvent[];
}): DeterministicGateResult[] {
  return [
    {
      id: 'no_deploy_through_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: releaseGate, mode: 'deployable' }),
    },
    {
      id: 'no_deploy_through_blockers_trajectory',
      check: 'release_gate_read_before_deploy',
      ...runDeterministicCheck({ name: 'release_gate_read_before_deploy', events, stage }),
    },
    {
      id: 'verification_evidence_present_trajectory',
      check: 'live_verify_after_deploy',
      ...runDeterministicCheck({ name: 'live_verify_after_deploy', events, stage }),
    },
  ];
}

export function deploymentGateFailureNextSteps({
  report,
  failedChecks,
}: {
  report: DeploymentReport;
  failedChecks: DeterministicGateResult[];
}) {
  const deterministicRemediation = failedChecks.map((check) => {
    const id = check.id ?? check.check ?? 'deployment_gate';
    return `Fix deterministic deployment gate ${id}: ${check.reason}`;
  });
  const reportRemediation = report.issues.map((issue) => `${issue.description}: ${issue.action}`);

  return [
    ...deterministicRemediation,
    ...reportRemediation,
    ...(report.result === 'failure' && !reportRemediation.length
      ? [`Deployment report result was failure; next action is ${report.next_action}.`]
      : []),
  ];
}
