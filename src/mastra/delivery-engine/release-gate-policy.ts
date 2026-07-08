import { compactDiagnostic } from './agent-runtime/diagnostics';
import {
  planSchemaComplete,
  runDeterministicCheck,
  type DeliveryEvent,
} from './checks';
import type { DeterministicGateResult } from './judgment';
import {
  releaseGateRequiredEvidencePassed,
  type ReleaseGateEvidence,
} from './evidence/release-gate-evidence';
import type { ReleaseGate } from './workflow-schemas';

export function releaseGateDeterministicResults({
  stage,
  gate,
  events,
  evidence,
}: {
  stage: string;
  gate: ReleaseGate;
  events: DeliveryEvent[];
  evidence?: ReleaseGateEvidence;
}): DeterministicGateResult[] {
  return [
    { id: 'decision_explicit', check: 'plan_schema_complete', ...planSchemaComplete(gate) },
    { id: 'tier_order', check: 'tier_order', ...runDeterministicCheck({ name: 'tier_order', subject: gate }) },
    {
      id: 'pass_with_open_blockers',
      check: 'release_blockers_zero',
      ...runDeterministicCheck({ name: 'release_blockers_zero', subject: gate }),
    },
    {
      id: 'critical_area_evidence_trajectory',
      check: 'harness_run_before_findings',
      ...runDeterministicCheck({ name: 'harness_run_before_findings', events, stage }),
    },
    releaseGateRequiredEvidencePassed(evidence),
  ];
}

export function releaseGateForInvalidTesterOutput(error: unknown): ReleaseGate {
  const diagnostic = compactDiagnostic(error, 900);
  const reason = `Tester did not return a structured release-gate object: ${diagnostic}`;

  return {
    artifact_type: 'release-gate',
    decision: 'fail',
    event_type: 'pre_deployment',
    tiers: [
      {
        tier: 'smoke',
        status: 'failed',
        reason,
      },
      {
        tier: 'api',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'e2e',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
      {
        tier: 'full_matrix',
        status: 'skipped',
        reason: 'Structured release-gate output was unavailable after tester execution.',
      },
    ],
    critical_areas: [
      'auth',
      'billing',
      'state_integrity',
      'data_safety',
      'deployment_correctness',
      'error_responses',
    ].map((area) => ({
      area: area as ReleaseGate['critical_areas'][number]['area'],
      status: 'missing' as const,
      reason,
    })),
    blockers: [
      reason,
      'Rerun the release gate and return only { "gate": <release-gate> } after executing evidence commands.',
    ],
    cosmetic_issues: [],
    summary: 'Release gate failed closed because the tester returned malformed structured output.',
  };
}
