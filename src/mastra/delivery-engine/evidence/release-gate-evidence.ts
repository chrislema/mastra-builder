import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import { packageVerificationScripts } from '../build-deployment-policy';
import type { DeterministicGateResult } from '../judgment';
import {
  releaseGateEvidenceCommandPlanFromOptions,
  releaseGateLocalD1DatabaseName as releaseGateLocalD1DatabaseNameBase,
  releaseGateMigrationText as releaseGateMigrationTextBase,
  releaseGateRequiredStaticEvidenceFailures as releaseGateRequiredStaticEvidenceFailuresBase,
  releaseGateStaticEvidenceResultsFromOptions,
  releaseGateWorkerDeployDryRunCommand as releaseGateWorkerDeployDryRunCommandBase,
  releaseGateWorkerDevCommand as releaseGateWorkerDevCommandBase,
  releaseGateWorkerStartupCheckCommand as releaseGateWorkerStartupCheckCommandBase,
  releaseGateWorkerTypesCheckCommand as releaseGateWorkerTypesCheckCommandBase,
  type ReleaseGateEvidence,
  type ReleaseGateEvidenceCommand,
  type ReleaseGateEvidenceResult,
} from '../release-gate-command-plan';
import {
  runHttpProbe,
  type ReleaseGateHttpProbeResult,
  type ReleaseGateRuntimeProbePlan,
} from '../release-gate-probes';
import {
  buildReleaseGateRuntimeProbePlan,
  releaseGateRuntimeProbePlanRequiresAdminSecret as runtimeProbePlanRequiresAdminSecret,
  type ReleaseGatePublicAssetProbeFile,
} from '../release-gate-runtime-probe-plan';
import {
  releaseGateTranscriptFixtureAvailable as transcriptFixtureAvailable,
  releaseGateTranscriptFixtureSchemaGaps as transcriptFixtureSchemaGaps,
  releaseGateTranscriptVersionAuditSql,
  writeReleaseGateTranscriptFixtureFile,
} from '../release-gate-transcript-fixture';
import { appendDeliveryEventState } from '../state-service';
import { sourcePolicyFromRepo } from '../source-policy';
import { appendBoundedOutput, availableTcpPort, delay, stopChildProcess } from '../process-utils';
import { ensureNodeDependencies } from './build-verification';
import { commandFailureSummary, execFileAsync, recordRunCodeStart } from './command-runner';
import { prepareReleaseGateLocalAdminSecret, releaseGateLocalAdminToken } from './local-admin-secret';

export type { ReleaseGateEvidence } from '../release-gate-command-plan';

function workerSourceSearchRoots(repoPath: string) {
  const root = resolve(repoPath);
  return [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.js'),
    join(root, 'worker.mjs'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];
}

function sourceTextContainsRouteLiteral(text: string, route: string) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp("(['\"`])" + escaped + '\\1').test(text);
}

function sourceTreeContainsRouteLiteral(rootPath: string, route: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return sourceTextContainsRouteLiteral(readFileSync(rootPath, 'utf8'), route);
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeContainsRouteLiteral(path, route, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (sourceTextContainsRouteLiteral(readFileSync(path, 'utf8'), route)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function workerSourceContainsRouteLiteral(repoPath: string, route: string) {
  const scanned = { count: 0 };
  return workerSourceSearchRoots(repoPath).some((sourceRoot) => sourceTreeContainsRouteLiteral(sourceRoot, route, scanned));
}

export function releaseGateLocalD1DatabaseName(repoPath: string) {
  return releaseGateLocalD1DatabaseNameBase(repoPath);
}

function releaseGateRepoHasRoute(repoPath: string, route: string) {
  const root = resolve(repoPath);
  if (
    route === '/health' &&
    ['src/routes/health.ts', 'src/routes/health.js', 'src/routes/health.mjs'].some((path) => existsSync(join(root, path)))
  ) {
    return true;
  }
  if (
    route === '/api/health' &&
    ['src/routes/api/health.ts', 'src/routes/api/health.js', 'src/routes/api/health.mjs'].some((path) =>
      existsSync(join(root, path)),
    )
  ) {
    return true;
  }
  return workerSourceContainsRouteLiteral(repoPath, route);
}

function releaseGateHealthRoutes(repoPath: string) {
  return ['/api/health', '/health'].filter((route) => releaseGateRepoHasRoute(repoPath, route));
}

function releaseGateMigrationText(repoPath: string) {
  return releaseGateMigrationTextBase(repoPath);
}

function releaseGateTranscriptFixtureContext(repoPath: string) {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return {
    repoPath,
    sourcePolicy,
    latestRoutePresent: releaseGateRepoHasRoute(repoPath, '/latest'),
    localD1DatabaseName: releaseGateLocalD1DatabaseName(repoPath),
    migrationText: releaseGateMigrationText(repoPath),
  };
}

export function releaseGateTranscriptFixtureSchemaGaps(repoPath: string) {
  return transcriptFixtureSchemaGaps(releaseGateTranscriptFixtureContext(repoPath));
}

function releaseGateTranscriptFixtureAvailable(repoPath: string) {
  return transcriptFixtureAvailable(releaseGateTranscriptFixtureContext(repoPath));
}

export function releaseGateWorkerDevCommand(
  repoPath: string,
  port: number | '<port>' = '<port>',
  persistTo?: string | '<persist-to>',
) {
  return releaseGateWorkerDevCommandBase(repoPath, port, persistTo);
}

export function releaseGateWorkerDeployDryRunCommand(repoPath: string) {
  return releaseGateWorkerDeployDryRunCommandBase(repoPath);
}

export function releaseGateWorkerStartupCheckCommand(repoPath: string) {
  return releaseGateWorkerStartupCheckCommandBase(repoPath);
}

export function releaseGateWorkerTypesCheckCommand(repoPath: string) {
  return releaseGateWorkerTypesCheckCommandBase(repoPath);
}

function releaseGateStaticAssetTextMarker(repoPath: string, file: ReleaseGatePublicAssetProbeFile) {
  const assetPath = join(resolve(repoPath), 'public', file);
  if (!existsSync(assetPath)) return undefined;
  const text = readFileSync(assetPath, 'utf8').trim();
  return text ? text.slice(0, 120) : undefined;
}

export function releaseGateRuntimeProbePlanRequiresAdminSecret(plan: ReleaseGateRuntimeProbePlan | undefined) {
  return runtimeProbePlanRequiresAdminSecret(plan);
}

export function releaseGateRuntimeProbePlan(
  repoPath: string,
  adminToken = releaseGateLocalAdminToken,
): ReleaseGateRuntimeProbePlan | undefined {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return buildReleaseGateRuntimeProbePlan({
    command: releaseGateWorkerDevCommand(repoPath),
    adminToken,
    publicAssetTextMarker: (file) => releaseGateStaticAssetTextMarker(repoPath, file),
    healthRoutes: releaseGateHealthRoutes(repoPath),
    hasRoute: (route) => releaseGateRepoHasRoute(repoPath, route),
    latestTranscriptRequired: sourcePolicy.latestTranscriptRequired,
    shortLinkLifecycleRequired: sourcePolicy.shortLinkLifecycleRequired,
    transcriptFixtureAvailable: releaseGateTranscriptFixtureAvailable(repoPath),
  });
}

function createReleaseGateRuntimeStatePath(repoPath: string) {
  const stateRoot = join(resolve(repoPath), '.delivery', 'tmp');
  mkdirSync(stateRoot, { recursive: true });
  const persistTo = join(stateRoot, `wrangler-state-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  mkdirSync(persistTo, { recursive: true });
  return persistTo;
}

export function releaseGateEvidenceCommandPlan(repoPath: string, persistTo?: string): ReleaseGateEvidenceCommand[] {
  return releaseGateEvidenceCommandPlanFromOptions({
    repoPath,
    persistTo,
    packageVerificationScripts: packageVerificationScripts(repoPath),
    transcriptFixtureAvailable: releaseGateTranscriptFixtureAvailable(repoPath),
    writeTranscriptFixtureFile: () => writeReleaseGateTranscriptFixtureFile(repoPath),
    transcriptVersionAuditSql: releaseGateTranscriptVersionAuditSql(),
  });
}

export function releaseGateStaticEvidenceResults(repoPath: string): ReleaseGateEvidenceResult[] {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return releaseGateStaticEvidenceResultsFromOptions({
    repoPath,
    latestTranscriptRequired: sourcePolicy.latestTranscriptRequired,
    latestRoutePresent: releaseGateRepoHasRoute(repoPath, '/latest'),
    migrationText: releaseGateMigrationText(repoPath),
    transcriptFixtureGaps: releaseGateTranscriptFixtureSchemaGaps(repoPath),
  });
}

export function releaseGateRequiredStaticEvidenceFailures(results: ReleaseGateEvidenceResult[]) {
  return releaseGateRequiredStaticEvidenceFailuresBase(results);
}

async function recordReleaseGateStaticEvidenceResult({
  repoPath,
  mastra,
  stage,
  result,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  result: ReleaseGateEvidenceResult;
}) {
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'run_code',
      stage,
      command: result.command,
      ok: result.ok,
      output_summary: result.output_summary,
      error: result.error,
    },
  });
}

async function runReleaseGateEvidenceCommand({
  repoPath,
  mastra,
  stage,
  command,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  command: ReleaseGateEvidenceCommand;
}): Promise<ReleaseGateEvidenceResult> {
  await recordRunCodeStart({
    repoPath,
    mastra,
    stage,
    command: command.command,
    timeoutMs: command.tier === 'smoke' ? 120_000 : 180_000,
  });
  try {
    const result = await execFileAsync(command.executable, command.args, {
      cwd: resolve(repoPath),
      timeout: command.tier === 'smoke' ? 120_000 : 180_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    const output = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 700);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: true,
        output_summary: output,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: true,
      required: command.required,
      reason: command.reason,
      output_summary: output,
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
      },
    });
    return {
      tier: command.tier,
      command: command.command,
      ok: false,
      required: command.required,
      reason: command.reason,
      error: failure,
    };
  }
}

async function runReleaseGateRuntimeProbe({
  repoPath,
  mastra,
  stage,
  persistTo,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  persistTo?: string;
}): Promise<ReleaseGateEvidenceResult | undefined> {
  const initialPlan = releaseGateRuntimeProbePlan(repoPath);
  if (!initialPlan) return undefined;

  const adminSecret = releaseGateRuntimeProbePlanRequiresAdminSecret(initialPlan)
    ? prepareReleaseGateLocalAdminSecret(repoPath)
    : undefined;
  const plan = adminSecret ? releaseGateRuntimeProbePlan(repoPath, adminSecret.token) : initialPlan;
  if (!plan) return undefined;

  const port = await availableTcpPort();
  const command = releaseGateWorkerDevCommand(repoPath, port, persistTo ?? createReleaseGateRuntimeStatePath(repoPath));
  if (!command) return undefined;

  let output = '';
  let processError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let probes: ReleaseGateHttpProbeResult[] = [];
  await recordRunCodeStart({ repoPath, mastra, stage, command: command.command, timeoutMs: 75_000 });
  const child = spawn(command.executable, command.args, {
    cwd: resolve(repoPath),
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...(adminSecret ? { ADMIN_TOKEN: adminSecret.token } : {}),
      CI: process.env.CI ?? '1',
      NO_COLOR: '1',
      WRANGLER_SEND_METRICS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk);
  });
  child.once('error', (error) => {
    processError = error;
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 75_000;
  try {
    while (Date.now() < deadline) {
      if (processError) throw processError;
      if (exit) throw new Error(`Worker runtime command exited before probes passed: code ${exit.code}, signal ${exit.signal}.`);

      probes = [];
      const probeVariables: Record<string, string> = {};
      for (const probe of plan.probes) {
        probes.push(await runHttpProbe(baseUrl, probe, probeVariables));
      }

      if (probes.every((probe) => probe.ok)) {
        const outputSummary = compactDiagnostic(output.trim() || 'wrangler dev served all runtime probes.', 900);
        await appendDeliveryEventState({
          repoPath,
          mastra,
          event: {
            type: 'run_code',
            stage,
            command: command.command,
            ok: true,
            output_summary: outputSummary,
            probes,
          },
        });
        return {
          tier: plan.tier,
          command: command.command,
          ok: true,
          required: plan.required,
          reason: plan.reason,
          output_summary: outputSummary,
          probes,
        };
      }

      await delay(1_000);
    }

    throw new Error(`Worker runtime probes did not pass within 75s. Last probe results: ${JSON.stringify(probes)}`);
  } catch (error) {
    const failure = compactDiagnostic(`${compactDiagnostic(error, 900)}\n${output}`, 1_400);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command: command.command,
        ok: false,
        error: failure,
        probes,
      },
    });
    return {
      tier: plan.tier,
      command: command.command,
      ok: false,
      required: plan.required,
      reason: plan.reason,
      error: failure,
      probes,
    };
  } finally {
    await stopChildProcess(child);
    adminSecret?.restore();
  }
}

export async function collectReleaseGateEvidence({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<ReleaseGateEvidence> {
  const dependencyInstall = await ensureNodeDependencies({ repoPath, mastra, stage });

  const runtimePlan = releaseGateRuntimeProbePlan(repoPath);
  const runtimePersistTo = runtimePlan ? createReleaseGateRuntimeStatePath(repoPath) : undefined;
  const plan = releaseGateEvidenceCommandPlan(repoPath, runtimePersistTo);
  const staticResults = releaseGateStaticEvidenceResults(repoPath);
  const requiredStaticFailures = releaseGateRequiredStaticEvidenceFailures(staticResults);
  const notes: string[] = [];
  if (!plan.some((command) => command.tier === 'smoke')) {
    notes.push('No package verification script was available; smoke tier must be marked not_required or blocked with a reason.');
  }
  if (!plan.some((command) => command.tier === 'api') && !runtimePlan) {
    notes.push('No local D1 migration command or Worker runtime probe was planned; API tier should be not_required unless other API evidence exists.');
  }
  if (!runtimePlan) {
    notes.push('No Wrangler Worker config was detected, so local Worker runtime startup was not probed.');
  }
  if (releaseGateTranscriptFixtureAvailable(repoPath)) {
    notes.push(
      'Release gate seeds D1 with a completed run containing original and regenerated transcript versions, then probes GET /latest against the same local Wrangler state.',
    );
  }
  if (requiredStaticFailures.length) {
    notes.push(
      `Skipped dynamic Worker API evidence because required static release-gate checks failed: ${requiredStaticFailures
        .map((result) => result.command)
        .join(', ')}.`,
    );
  }
  notes.push('No browser E2E harness is started by this workflow; E2E and full_matrix tiers should be not_required unless cited evidence exists.');

  const commands: ReleaseGateEvidenceResult[] = [];
  if (dependencyInstall) {
    commands.push({
      tier: 'smoke',
      command: dependencyInstall.command,
      ok: dependencyInstall.ok,
      required: true,
      reason: dependencyInstall.reason,
      output_summary: dependencyInstall.output_summary,
      error: dependencyInstall.error,
    });
  }
  const dynamicPlan = plan.filter((command) => command.tier !== 'smoke');
  for (const command of plan.filter((item) => item.tier === 'smoke')) {
    commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
  }
  for (const result of staticResults) {
    await recordReleaseGateStaticEvidenceResult({ repoPath, mastra, stage, result });
    commands.push(result);
  }
  if (!requiredStaticFailures.length) {
    for (const command of dynamicPlan) {
      commands.push(await runReleaseGateEvidenceCommand({ repoPath, mastra, stage, command }));
    }
    const runtimeResult = await runReleaseGateRuntimeProbe({ repoPath, mastra, stage, persistTo: runtimePersistTo });
    if (runtimeResult) commands.push(runtimeResult);
  }

  return {
    artifact_type: 'test-evidence',
    stage,
    commands,
    notes,
  };
}

export function releaseGateRequiredEvidencePassed(evidence?: ReleaseGateEvidence): DeterministicGateResult {
  if (!evidence) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: 'release gate evidence artifact was not available',
    };
  }

  const required = evidence.commands.filter((command) => command.required);
  const failed = required.filter((command) => !command.ok);
  if (failed.length) {
    return {
      id: 'required_evidence_passed',
      check: 'required_evidence_passed',
      passed: false,
      reason: `required release-gate evidence failed: ${failed
        .map((command) => `${command.command}: ${command.error ?? 'failed'}`)
        .join('; ')}`,
    };
  }

  return {
    id: 'required_evidence_passed',
    check: 'required_evidence_passed',
    passed: true,
    reason: required.length
      ? `all required release-gate evidence passed: ${required.map((command) => command.command).join(', ')}`
      : 'no required release-gate evidence commands were planned',
  };
}
