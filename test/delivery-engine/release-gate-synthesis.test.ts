import assert from 'node:assert/strict';
import test from 'node:test';
import { synthesizeReleaseGateFromEvidence } from '../../src/mastra/delivery-engine/release-gate-synthesis.ts';
import { releaseGateSchema } from '../../src/mastra/delivery-engine/workflow-schemas.ts';
import type { ReleaseGateEvidence } from '../../src/mastra/delivery-engine/release-gate-command-plan.ts';

function evidence(commands: ReleaseGateEvidence['commands']): ReleaseGateEvidence {
  return {
    artifact_type: 'test-evidence',
    stage: 'test:a1',
    notes: ['No browser E2E harness is started by this workflow; E2E and full_matrix tiers should be not_required.'],
    commands,
  };
}

test('deterministic release gate passes when required evidence passes', () => {
  const gate = synthesizeReleaseGateFromEvidence({
    evidence: evidence([
      {
        tier: 'smoke',
        command: 'npm test',
        ok: true,
        required: true,
        reason: 'Project verification script "test" was available.',
        output_summary: 'tests passed',
      },
      {
        tier: 'api',
        command: 'npx wrangler dev --env staging --ip 127.0.0.1 --port 8787',
        ok: true,
        required: true,
        reason: 'A Wrangler Worker config was present, so local runtime verification is required before deployment.',
        output_summary: 'wrangler dev served all runtime probes',
        probes: [
          {
            method: 'GET',
            path: '/health',
            url: 'http://127.0.0.1:8787/health',
            expected: 'Worker health route responds below 500.',
            ok: true,
            response_summary: 'HTTP 200',
          },
          {
            method: 'GET',
            path: '/missing',
            url: 'http://127.0.0.1:8787/missing',
            expected: 'Missing routes return a controlled not found response.',
            ok: true,
            response_summary: 'HTTP 404 not found',
          },
        ],
      },
    ]),
    evidencePath: '.delivery/artifacts/test-evidence.a1.json',
  });

  assert.equal(gate.decision, 'pass');
  assert.equal(gate.blockers.length, 0);
  assert.equal(gate.tiers.find((tier) => tier.tier === 'smoke')?.status, 'passed');
  assert.equal(gate.tiers.find((tier) => tier.tier === 'api')?.status, 'passed');
  assert.equal(gate.tiers.find((tier) => tier.tier === 'e2e')?.status, 'not_required');
  assert.equal(gate.critical_areas.find((area) => area.area === 'deployment_correctness')?.status, 'verified');
  assert.equal(gate.critical_areas.find((area) => area.area === 'error_responses')?.status, 'verified');
  releaseGateSchema.parse(gate);
});

test('deterministic release gate fails closed when required evidence fails', () => {
  const gate = synthesizeReleaseGateFromEvidence({
    evidence: evidence([
      {
        tier: 'smoke',
        command: 'npm test',
        ok: false,
        required: true,
        reason: 'Project verification script "test" was available.',
        error: 'test failed',
      },
    ]),
  });

  assert.equal(gate.decision, 'fail');
  assert.equal(gate.tiers.find((tier) => tier.tier === 'smoke')?.status, 'failed');
  assert.match(gate.blockers.join('\n'), /Required smoke evidence failed: npm test: test failed/);
  assert.equal(gate.critical_areas.find((area) => area.area === 'deployment_correctness')?.status, 'missing');
  releaseGateSchema.parse(gate);
});

test('deterministic release gate fails closed when no required evidence exists', () => {
  const gate = synthesizeReleaseGateFromEvidence({
    evidence: evidence([]),
  });

  assert.equal(gate.decision, 'fail');
  assert.match(gate.blockers.join('\n'), /No required release-gate evidence was collected/);
  assert.equal(gate.tiers.every((tier) => tier.status === 'not_required'), true);
  releaseGateSchema.parse(gate);
});
