import type { ReleaseGateEvidence, ReleaseGateEvidenceResult } from './release-gate-command-plan';
import type { ReleaseGate } from './workflow-schemas';

type ReleaseGateTier = ReleaseGate['tiers'][number]['tier'];
type CriticalArea = ReleaseGate['critical_areas'][number]['area'];

const orderedTiers: ReleaseGateTier[] = ['smoke', 'api', 'e2e', 'full_matrix'];
const criticalAreas: CriticalArea[] = [
  'auth',
  'billing',
  'state_integrity',
  'data_safety',
  'deployment_correctness',
  'error_responses',
];

function compact(value: string | undefined, limit = 220) {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function commandRef(command: ReleaseGateEvidenceResult) {
  return command.command;
}

function tierReason(tier: ReleaseGateTier, evidence: ReleaseGateEvidence, commands: ReleaseGateEvidenceResult[]) {
  if (commands.length) {
    const failed = commands.filter((command) => !command.ok);
    if (failed.length) {
      return failed.map((command) => `${command.command}: ${compact(command.error) ?? 'failed'}`).join('; ');
    }
    return commands.map((command) => command.reason).filter(Boolean).join('; ') || `${tier} evidence passed.`;
  }

  if (tier === 'e2e' || tier === 'full_matrix') {
    return evidence.notes.find((note) => /No browser E2E harness/i.test(note)) ?? 'No browser E2E/full-matrix harness was planned.';
  }
  if (tier === 'api') {
    return evidence.notes.find((note) => /No local D1 migration command|No Wrangler Worker config/i.test(note)) ??
      'No API/runtime evidence command was planned for this project shape.';
  }
  return evidence.notes.find((note) => /No package verification script/i.test(note)) ??
    'No smoke verification command was planned for this project shape.';
}

function tierStatus(
  tier: ReleaseGateTier,
  evidence: ReleaseGateEvidence,
): ReleaseGate['tiers'][number] {
  const commands = evidence.commands.filter((command) => command.tier === tier);
  if (!commands.length) {
    return {
      tier,
      status: 'not_required',
      reason: tierReason(tier, evidence, commands),
    };
  }

  const failed = commands.filter((command) => !command.ok);
  if (failed.length) {
    return {
      tier,
      status: 'failed',
      run_ref: failed.map(commandRef).join('; '),
      reason: tierReason(tier, evidence, commands),
    };
  }

  return {
    tier,
    status: 'passed',
    run_ref: commands.map(commandRef).join('; '),
    reason: tierReason(tier, evidence, commands),
  };
}

function failedRequiredEvidence(evidence: ReleaseGateEvidence) {
  return evidence.commands.filter((command) => command.required && !command.ok);
}

function passedRequiredEvidence(evidence: ReleaseGateEvidence) {
  return evidence.commands.filter((command) => command.required && command.ok);
}

function anyEvidenceText(evidence: ReleaseGateEvidence, pattern: RegExp) {
  return evidence.commands.some((command) =>
    pattern.test(
      [
        command.tier,
        command.command,
        command.reason,
        command.output_summary,
        command.error,
        ...(command.probes ?? []).flatMap((probe) => [
          probe.method,
          probe.path,
          probe.expected,
          probe.response_summary,
          probe.error,
        ]),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  );
}

function passedEvidenceSummary(evidence: ReleaseGateEvidence, pattern?: RegExp) {
  const commands = evidence.commands.filter((command) => command.ok && (!pattern || anyCommandText(command, pattern)));
  return commands.map((command) => command.command).join('; ');
}

function anyCommandText(command: ReleaseGateEvidenceResult, pattern: RegExp) {
  return pattern.test(
    [
      command.tier,
      command.command,
      command.reason,
      command.output_summary,
      command.error,
      ...(command.probes ?? []).flatMap((probe) => [
        probe.method,
        probe.path,
        probe.expected,
        probe.response_summary,
        probe.error,
      ]),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function areaStatus(area: CriticalArea, evidence: ReleaseGateEvidence): ReleaseGate['critical_areas'][number] {
  const failedRequired = failedRequiredEvidence(evidence);
  const passedRequired = passedRequiredEvidence(evidence);
  const failedReason = failedRequired.map((command) => `${command.command}: ${compact(command.error) ?? 'failed'}`).join('; ');
  const passedSummary = passedRequired.map((command) => command.command).join('; ');
  const hasRuntimeProbe = evidence.commands.some((command) => command.ok && (command.probes?.length ?? 0) > 0);
  const hasStateEvidence = anyEvidenceText(evidence, /\b(?:D1|migration|database|SQLite|transcript|KV|R2|storage|persist)/i);
  const hasAuthEvidence = anyEvidenceText(evidence, /\b(?:auth|admin|token|session|credential|unauthorized|forbidden|401|403)\b/i);
  const hasBillingEvidence = anyEvidenceText(evidence, /\b(?:billing|payment|invoice|stripe|checkout)\b/i);
  const hasErrorEvidence = anyEvidenceText(evidence, /\b(?:error|invalid|404|400|401|403|500|not found|bad request)\b/i);

  if (area === 'billing') {
    return hasBillingEvidence
      ? {
          area,
          status: failedRequired.length ? 'missing' : 'verified',
          evidence: passedEvidenceSummary(evidence, /\b(?:billing|payment|invoice|stripe|checkout)\b/i) || passedSummary,
          reason: failedRequired.length ? failedReason : undefined,
        }
      : { area, status: 'not_applicable', reason: 'No billing surface was detected in release-gate evidence.' };
  }

  if (area === 'auth') {
    return hasAuthEvidence
      ? {
          area,
          status: failedRequired.length ? 'missing' : 'verified',
          evidence: passedEvidenceSummary(evidence, /\b(?:auth|admin|token|session|credential|unauthorized|forbidden|401|403)\b/i) ||
            passedSummary,
          reason: failedRequired.length ? failedReason : undefined,
        }
      : { area, status: 'not_applicable', reason: 'No auth surface was detected in release-gate evidence.' };
  }

  if (area === 'state_integrity') {
    if (!hasStateEvidence) return { area, status: 'not_applicable', reason: 'No stateful storage evidence was detected.' };
    return failedRequired.length
      ? { area, status: 'missing', reason: failedReason }
      : {
          area,
          status: 'verified',
          evidence: passedEvidenceSummary(evidence, /\b(?:D1|migration|database|SQLite|transcript|KV|R2|storage|persist)/i) ||
            passedSummary,
        };
  }

  if (area === 'data_safety') {
    if (!hasStateEvidence && !hasAuthEvidence) {
      return { area, status: 'not_applicable', reason: 'No storage/auth data-safety surface was detected.' };
    }
    return failedRequired.length
      ? { area, status: 'missing', reason: failedReason }
      : { area, status: 'verified', evidence: passedSummary };
  }

  if (area === 'error_responses') {
    if (!hasRuntimeProbe && !hasErrorEvidence) {
      return { area, status: 'not_applicable', reason: 'No runtime error-response probe was planned.' };
    }
    return failedRequired.length
      ? { area, status: 'missing', reason: failedReason }
      : { area, status: 'verified', evidence: passedEvidenceSummary(evidence, /\b(?:error|invalid|404|400|401|403|500|not found|bad request)\b/i) || passedSummary };
  }

  if (failedRequired.length) {
    return { area, status: 'missing', reason: failedReason };
  }
  if (!passedRequired.length) {
    return { area, status: 'missing', reason: 'No required release-gate evidence was collected.' };
  }
  return { area, status: 'verified', evidence: passedSummary };
}

export function synthesizeReleaseGateFromEvidence({
  evidence,
  evidencePath,
}: {
  evidence: ReleaseGateEvidence;
  evidencePath?: string;
}): ReleaseGate {
  const tiers = orderedTiers.map((tier) => tierStatus(tier, evidence));
  const critical_areas = criticalAreas.map((area) => areaStatus(area, evidence));
  const failedRequired = failedRequiredEvidence(evidence);
  const missingAreas = critical_areas.filter((area) => area.status === 'missing');
  const blockers = [
    ...failedRequired.map(
      (command) => `Required ${command.tier} evidence failed: ${command.command}: ${compact(command.error) ?? 'failed'}`,
    ),
    ...(!passedRequiredEvidence(evidence).length ? ['No required release-gate evidence was collected.'] : []),
    ...missingAreas.map((area) => `${area.area} missing: ${area.reason ?? 'required critical-area evidence missing'}`),
  ];
  const uniqueBlockers = Array.from(new Set(blockers));
  const decision = uniqueBlockers.length ? 'fail' : 'pass';
  const evidenceRef = evidencePath ? ` Evidence artifact: ${evidencePath}.` : '';

  return {
    artifact_type: 'release-gate',
    decision,
    event_type: 'pre_deployment',
    tiers,
    critical_areas,
    blockers: uniqueBlockers,
    cosmetic_issues: [],
    summary:
      decision === 'pass'
        ? `Deterministic release gate passed from ${passedRequiredEvidence(evidence).length} required evidence command(s).${evidenceRef}`
        : `Deterministic release gate failed closed with ${uniqueBlockers.length} blocker(s).${evidenceRef}`,
  };
}
