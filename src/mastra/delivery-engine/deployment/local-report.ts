import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deploymentReportSuccessNextSteps as deploymentReportSuccessNextStepsBase,
  localDeploymentReportFromReleaseGateEvidence as localDeploymentReportFromReleaseGateEvidenceBase,
} from '../build-deployment-policy';
import type { ReleaseGateEvidence } from '../evidence/release-gate-evidence';
import type { DeploymentReport, ReleaseGate } from '../workflow-schemas';

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export function latestArtifactPath(artifacts: string[], needle: string, fallback: string) {
  return [...artifacts].reverse().find((path) => path.includes(needle) && !path.includes('/judgments/')) ?? fallback;
}

export function latestReleaseGateEvidencePath(artifacts: string[]) {
  const path = latestArtifactPath(artifacts, 'test-evidence', '');
  return path || undefined;
}

export function readReleaseGateEvidenceArtifact(repoPath: string, artifacts: string[]) {
  const evidencePath = latestReleaseGateEvidencePath(artifacts);
  if (!evidencePath) return undefined;

  const evidence = readJsonArtifact(repoPath, evidencePath);
  if (!evidence || typeof evidence !== 'object') return undefined;
  if ((evidence as { artifact_type?: unknown }).artifact_type !== 'test-evidence') return undefined;
  return evidence as ReleaseGateEvidence;
}

export function localDeploymentReportFromReleaseGateEvidence({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
}): DeploymentReport {
  return localDeploymentReportFromReleaseGateEvidenceBase({ runId, releaseGate, evidence, releaseGatePath, evidencePath });
}

export function deploymentReportSuccessNextSteps(report: DeploymentReport, repoPath: string) {
  return deploymentReportSuccessNextStepsBase(report, repoPath);
}
