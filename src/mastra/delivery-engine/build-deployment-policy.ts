import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  releaseGateWorkerDeployDryRunCommand,
  wranglerProcessCommand,
  type ReleaseGateEvidence,
} from './release-gate-command-plan';
import type { ReleaseGateProcessCommand } from './release-gate-probes';
import type { DeploymentReport, ReleaseGate } from './workflow-schemas';

function packageScripts(repoPath: string) {
  const packagePath = join(resolve(repoPath), 'package.json');
  if (!existsSync(packagePath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: unknown };
    return parsed.scripts && typeof parsed.scripts === 'object'
      ? (parsed.scripts as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function packageVerificationScripts(repoPath: string) {
  const scripts = packageScripts(repoPath);
  return ['typecheck', 'check', 'test', 'build'].filter((script) => typeof scripts[script] === 'string');
}

function buildVerificationScript(repoPath: string) {
  return packageVerificationScripts(repoPath)[0];
}

export function buildVerificationCommandPlan(repoPath: string) {
  const script = buildVerificationScript(repoPath);
  if (script) {
    return {
      command: `npm run ${script}`,
      executable: 'npm',
      args: ['run', script],
      timeoutMs: 120_000,
    };
  }

  const dryRunCommand = releaseGateWorkerDeployDryRunCommand(repoPath);
  if (!dryRunCommand) return undefined;

  return {
    ...dryRunCommand,
    timeoutMs: 180_000,
  };
}

function releaseGateEvidenceVerification(evidence?: ReleaseGateEvidence) {
  const commandRows =
    evidence?.commands.map((command) => ({
      check: command.command,
      expected: command.reason,
      actual: command.ok ? (command.output_summary ?? 'passed') : (command.error ?? 'failed'),
      passed: command.ok,
    })) ?? [];
  const probeRows =
    evidence?.commands.flatMap((command) =>
      (command.probes ?? []).map((probe) => ({
        check: `${probe.method} ${probe.path}`,
        expected: probe.expected,
        actual: probe.ok ? (probe.response_summary ?? 'passed') : (probe.error ?? 'failed'),
        passed: probe.ok,
      })),
    ) ?? [];

  return [...commandRows, ...probeRows];
}

function releaseGateEvidenceIssues(evidence?: ReleaseGateEvidence): DeploymentReport['issues'] {
  const issues: DeploymentReport['issues'] = [];
  for (const command of evidence?.commands ?? []) {
    if (!command.ok) {
      issues.push({
        description: `Release-gate evidence command failed: ${command.command}`,
        impact: command.required
          ? 'Required local validation evidence is missing.'
          : 'Optional local validation evidence is unavailable.',
        action: command.required
          ? 'Fix the failed evidence command before production approval.'
          : 'Review whether this optional evidence should become required.',
      });
    }
    for (const probe of command.probes ?? []) {
      if (!probe.ok) {
        issues.push({
          description: `Local Worker probe failed: ${probe.method} ${probe.path}`,
          impact: probe.expected,
          action: probe.error ?? 'Fix the route or probe expectation before production approval.',
        });
      }
    }
  }
  return issues;
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
  const verification = releaseGateEvidenceVerification(evidence);
  const issues = releaseGateEvidenceIssues(evidence);
  const migrationCommands =
    evidence?.commands
      .filter((command) => command.ok && /\bwrangler\s+d1\s+migrations\s+apply\b/.test(command.command))
      .map((command) => command.command) ?? [];
  const hasRequiredIssue = issues.some((issue) => /Required/.test(issue.impact));
  const releaseGatePassed = releaseGate.decision === 'pass' && releaseGate.blockers.length === 0;
  const result = releaseGatePassed && !hasRequiredIssue ? 'success' : 'failure';

  return {
    artifact_type: 'deployment-report',
    environment: 'local',
    revision: `local:${runId}`,
    migrations_applied: migrationCommands,
    config_changes: [
      'Production deployment not executed; local report synthesized from passing release-gate evidence.',
      'GitHub Actions not used as the deployment path.',
      `Release gate: ${releaseGatePath}`,
      ...(evidencePath ? [`Evidence: ${evidencePath}`] : []),
    ],
    result,
    verification: verification.length
      ? verification
      : [
          {
            check: 'release gate',
            expected: 'Passing pre-deployment release gate with zero blockers.',
            actual: releaseGate.summary,
            passed: releaseGatePassed,
          },
        ],
    issues,
    next_action: result === 'success' ? 'proceed' : 'fix',
    rollback: {
      prior_revision: 'none (local validation only)',
      steps: 'No production rollback is required because no Wrangler production deploy command ran.',
      data_caveats: 'Local Wrangler/D1/R2 state is validation-only and may live under .delivery/tmp.',
    },
  };
}

export function productionWranglerDeployCommand(repoPath: string): ReleaseGateProcessCommand {
  return wranglerProcessCommand(repoPath, 'deploy --env production', ['deploy', '--env', 'production']);
}

export function wranglerDeployUrls(output: string) {
  return Array.from(new Set(output.match(/https:\/\/[^\s"'<>]+/g) ?? [])).map((url) => url.replace(/[),.;]+$/, ''));
}

export function wranglerDeployRevision(output: string, runId: string) {
  const version = /\b(?:Version ID|Version|version)\s*[:=]\s*([A-Za-z0-9_-]{8,})\b/.exec(output)?.[1];
  return version ? `wrangler:${version}` : `production:${runId}`;
}

export function productionDeploymentReportFromWranglerResult({
  runId,
  releaseGate,
  evidence,
  releaseGatePath,
  evidencePath,
  deployCommand,
  deployOk,
  deployOutput,
  deployError,
  liveVerification,
  revision,
}: {
  runId: string;
  releaseGate: ReleaseGate;
  evidence?: ReleaseGateEvidence;
  releaseGatePath: string;
  evidencePath?: string;
  deployCommand: string;
  deployOk: boolean;
  deployOutput?: string;
  deployError?: string;
  liveVerification: DeploymentReport['verification'][number];
  revision?: string;
}): DeploymentReport {
  const evidenceVerification = releaseGateEvidenceVerification(evidence);
  const issues = releaseGateEvidenceIssues(evidence);
  const releaseGatePassed = releaseGate.decision === 'pass' && releaseGate.blockers.length === 0;
  const liveOk = liveVerification.passed !== false;

  if (!deployOk) {
    issues.push({
      description: `Wrangler production deploy failed: ${deployCommand}`,
      impact: 'Production was not updated.',
      action: 'Fix the deploy failure, rerun local release validation, then request production approval again.',
    });
  } else if (!liveOk) {
    issues.push({
      description: 'Production live verification failed after Wrangler deploy.',
      impact: 'The deployed Worker may be serving errors in production.',
      action: 'Inspect Wrangler deployment logs and rollback if the failure affects users.',
    });
  }

  const hasRequiredIssue = issues.some((issue) => /Required/.test(issue.impact));
  const result = releaseGatePassed && deployOk && liveOk && !hasRequiredIssue ? 'success' : 'failure';

  return {
    artifact_type: 'deployment-report',
    environment: 'production',
    revision: revision ?? wranglerDeployRevision(deployOutput ?? '', runId),
    migrations_applied: [],
    config_changes: [
      `Production deployment executed with Wrangler command: ${deployCommand}`,
      'GitHub Actions not used as the deployment path.',
      `Release gate: ${releaseGatePath}`,
      ...(evidencePath ? [`Evidence: ${evidencePath}`] : []),
    ],
    result,
    verification: [
      ...evidenceVerification,
      {
        check: deployCommand,
        expected: 'Wrangler production deploy command exits successfully.',
        actual: deployOk ? (deployOutput ?? 'deploy completed') : (deployError ?? 'deploy failed'),
        passed: deployOk,
      },
      liveVerification,
    ],
    issues,
    next_action: result === 'success' ? 'monitor' : deployOk ? 'rollback' : 'fix',
    rollback: {
      prior_revision: 'previous Cloudflare Worker deployment',
      steps: deployOk
        ? 'Use Wrangler versions/rollback for the Worker if live verification or monitoring shows production impact.'
        : 'No production rollback is required because the Wrangler deploy command did not complete successfully.',
      data_caveats: evidence?.commands.some((command) => /\bwrangler\s+d1\b/.test(command.command))
        ? 'Release-gate database evidence was local; verify any production D1 migration state separately before rollback.'
        : undefined,
    },
  };
}

export function deploymentReportSuccessNextSteps(report: DeploymentReport, repoPath: string) {
  if (report.environment === 'local') {
    return [
      `Local Wrangler validation passed. Review the deployment report and run npm run delivery:run -- --repo ${resolve(repoPath)} --deploy production when ready to request human approval before Wrangler production deploy.`,
    ];
  }

  return [report.next_action];
}
