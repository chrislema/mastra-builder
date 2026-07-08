import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeDeliveryPathReference } from './checks';
import type { ReleaseGateHttpProbeResult, ReleaseGateProcessCommand } from './release-gate-probes';
import {
  firstTomlStringValue,
  parseWranglerJsonConfig,
  repoLooksLikeWorkerProject,
  repoSourceUsesWorkersAi,
  repoUsesTypeScriptWorkerSource,
  workerConfigHasEnvironment,
  workerConfigHygieneGaps,
  workerConfigPath,
  workerJsonD1DatabaseName,
  workerJsonEnvironmentRecord,
  workerPackageScaffoldGaps,
  workerTomlD1DatabaseName,
  workersAiBindingGaps,
} from './worker-hygiene';

export type ReleaseGateEvidenceCommand = {
  tier: 'smoke' | 'api' | 'e2e' | 'full_matrix';
  command: string;
  executable: string;
  args: string[];
  required: boolean;
  reason: string;
};

export type ReleaseGateEvidenceResult = {
  tier: ReleaseGateEvidenceCommand['tier'];
  command: string;
  ok: boolean;
  required: boolean;
  reason: string;
  output_summary?: string;
  error?: string;
  probes?: ReleaseGateHttpProbeResult[];
};

export type ReleaseGateEvidence = {
  artifact_type: 'test-evidence';
  stage: string;
  commands: ReleaseGateEvidenceResult[];
  notes: string[];
};

export function localWranglerExecutable(repoPath: string) {
  const executable = join(resolve(repoPath), 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  return existsSync(executable) ? executable : undefined;
}

export function wranglerProcessCommand(repoPath: string, displayTail: string, args: string[]): ReleaseGateProcessCommand {
  const localWrangler = localWranglerExecutable(repoPath);
  if (localWrangler) {
    return {
      command: `./node_modules/.bin/wrangler ${displayTail}`,
      executable: localWrangler,
      args,
    };
  }

  return {
    command: `npx wrangler ${displayTail}`,
    executable: 'npx',
    args: ['wrangler', ...args],
  };
}

export function releaseGateWorkerDevCommand(
  repoPath: string,
  port: number | '<port>' = '<port>',
  persistTo?: string | '<persist-to>',
) {
  if (!workerConfigPath(repoPath)) return undefined;

  const portValue = String(port);
  const persistArgs = persistTo ? ['--persist-to', String(persistTo)] : [];
  const persistCommand = persistTo ? ` --persist-to ${String(persistTo)}` : '';
  return wranglerProcessCommand(repoPath, `dev --env staging --ip 127.0.0.1 --port ${portValue}${persistCommand}`, [
    'dev',
    '--env',
    'staging',
    '--ip',
    '127.0.0.1',
    '--port',
    portValue,
    ...persistArgs,
  ]);
}

export function releaseGateWorkerDeployDryRunCommand(repoPath: string) {
  if (!workerConfigPath(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'deploy --dry-run --env production', [
    'deploy',
    '--dry-run',
    '--env',
    'production',
  ]);
}

export function releaseGateWorkerStartupCheckCommand(repoPath: string) {
  if (!workerConfigPath(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'check startup --args="--env production"', [
    'check',
    'startup',
    '--args=--env production',
  ]);
}

function releaseGateWorkerConfigMain(repoPath: string) {
  const configPath = workerConfigPath(repoPath);
  if (!configPath) return undefined;

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return firstTomlStringValue(text, 'main');

  const config = parseWranglerJsonConfig(text);
  return typeof config?.main === 'string' ? config.main : undefined;
}

function workerSourceSurfaceIsTypeScript(surface: string) {
  const normalized = surface.toLowerCase();
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized)) return false;
  return /\.(?:ts|tsx|mts|cts)$/.test(normalized);
}

export function releaseGateHasTypeScriptWorkerSource(repoPath: string) {
  if (repoUsesTypeScriptWorkerSource(repoPath)) return true;

  const main = releaseGateWorkerConfigMain(repoPath);
  const normalizedMain = typeof main === 'string' ? normalizeDeliveryPathReference(main) : undefined;
  if (!normalizedMain || isAbsolute(normalizedMain) || !workerSourceSurfaceIsTypeScript(normalizedMain)) return false;

  return existsSync(join(resolve(repoPath), normalizedMain));
}

export function releaseGateWorkerTypesCheckCommand(repoPath: string) {
  if (!workerConfigPath(repoPath) || !releaseGateHasTypeScriptWorkerSource(repoPath)) return undefined;
  return wranglerProcessCommand(repoPath, 'types --check', ['types', '--check']);
}

function releaseGateLocalWorkerEnvironment(repoPath: string) {
  return workerConfigPath(repoPath) ? 'staging' : undefined;
}

export function releaseGateLocalD1Environment(repoPath: string) {
  return releaseGateLocalWorkerEnvironment(repoPath);
}

export function releaseGateLocalD1DatabaseName(repoPath: string) {
  const wranglerPath = workerConfigPath(repoPath);
  if (!wranglerPath) return undefined;

  const environmentName = workerConfigHasEnvironment(repoPath, 'staging') ? 'staging' : undefined;
  const text = readFileSync(wranglerPath, 'utf8');
  if (wranglerPath.endsWith('.toml')) {
    return (
      (environmentName ? workerTomlD1DatabaseName(text, environmentName) : undefined) ??
      workerTomlD1DatabaseName(text)
    );
  }

  const config = parseWranglerJsonConfig(text);
  const environment = environmentName && config ? workerJsonEnvironmentRecord(config, environmentName) : undefined;
  return workerJsonD1DatabaseName(environment) ?? workerJsonD1DatabaseName(config);
}

export function releaseGateMigrationText(repoPath: string) {
  const migrationsPath = join(resolve(repoPath), 'migrations');
  if (!existsSync(migrationsPath)) return '';

  return readdirSync(migrationsPath)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsPath, file), 'utf8'))
    .join('\n');
}

export type ReleaseGateEvidenceCommandPlanOptions = {
  repoPath: string;
  persistTo?: string;
  packageVerificationScripts: string[];
  transcriptFixtureAvailable: boolean;
  writeTranscriptFixtureFile: () => string;
  transcriptVersionAuditSql: string;
};

export function releaseGateEvidenceCommandPlanFromOptions({
  repoPath,
  persistTo,
  packageVerificationScripts,
  transcriptFixtureAvailable,
  writeTranscriptFixtureFile,
  transcriptVersionAuditSql,
}: ReleaseGateEvidenceCommandPlanOptions): ReleaseGateEvidenceCommand[] {
  const commands: ReleaseGateEvidenceCommand[] = [];
  const typesCheckCommand = releaseGateWorkerTypesCheckCommand(repoPath);
  if (typesCheckCommand) {
    commands.push({
      tier: 'smoke',
      command: typesCheckCommand.command,
      executable: typesCheckCommand.executable,
      args: typesCheckCommand.args,
      required: true,
      reason:
        'TypeScript Worker source and Wrangler config were present, so generated Worker binding types must be current before local validation.',
    });
  }

  for (const script of packageVerificationScripts) {
    commands.push({
      tier: 'smoke',
      command: `npm run ${script}`,
      executable: 'npm',
      args: ['run', script],
      required: true,
      reason: `Project verification script "${script}" was available.`,
    });
  }

  const deployDryRunCommand = releaseGateWorkerDeployDryRunCommand(repoPath);
  if (deployDryRunCommand) {
    commands.push({
      tier: 'api',
      command: deployDryRunCommand.command,
      executable: deployDryRunCommand.executable,
      args: deployDryRunCommand.args,
      required: true,
      reason:
        'A Wrangler Worker config was present, so production deploy bundling must pass a local Wrangler dry-run before approval.',
    });
  }

  const startupCheckCommand = releaseGateWorkerStartupCheckCommand(repoPath);
  if (startupCheckCommand) {
    commands.push({
      tier: 'api',
      command: startupCheckCommand.command,
      executable: startupCheckCommand.executable,
      args: startupCheckCommand.args,
      required: true,
      reason:
        'A Wrangler Worker config was present, so Worker startup must be profiled locally before production approval.',
    });
  }

  const databaseName = releaseGateLocalD1DatabaseName(repoPath);
  if (databaseName && existsSync(join(resolve(repoPath), 'migrations'))) {
    const environmentName = releaseGateLocalD1Environment(repoPath);
    const environmentArgs = environmentName ? ['--env', environmentName] : [];
    const environmentCommand = environmentName ? ` --env ${environmentName}` : '';
    const persistArgs = persistTo ? ['--persist-to', persistTo] : [];
    const persistCommand = persistTo ? ` --persist-to ${persistTo}` : '';
    const migrationCommand = wranglerProcessCommand(
      repoPath,
      `d1 migrations apply ${databaseName}${environmentCommand} --local${persistCommand}`,
      ['d1', 'migrations', 'apply', databaseName, ...environmentArgs, '--local', ...persistArgs],
    );
    commands.push({
      tier: 'api',
      command: migrationCommand.command,
      executable: migrationCommand.executable,
      args: migrationCommand.args,
      required: true,
      reason: 'Wrangler D1 config and migrations/ were present, so local D1 migration validation is required before deployment.',
    });

    if (transcriptFixtureAvailable) {
      const fixturePath = writeTranscriptFixtureFile();
      commands.push(
        {
          tier: 'api',
          ...wranglerProcessCommand(
            repoPath,
            `d1 execute ${databaseName}${environmentCommand} --local${persistCommand} --file ${fixturePath} --json`,
            ['d1', 'execute', databaseName, ...environmentArgs, '--local', ...persistArgs, '--file', fixturePath, '--json'],
          ),
          required: true,
          reason:
            'A latest transcript route and transcript schema were present, so release gate seeds a completed run with original and regenerated transcript versions.',
        },
        {
          tier: 'api',
          ...wranglerProcessCommand(
            repoPath,
            `d1 execute ${databaseName}${environmentCommand} --local${persistCommand} --command "${transcriptVersionAuditSql}" --json`,
            ['d1', 'execute', databaseName, ...environmentArgs, '--local', ...persistArgs, '--command', transcriptVersionAuditSql, '--json'],
          ),
          required: true,
          reason:
            'Transcript regeneration data-safety evidence: expected transcript_versions=2, preserved_original_versions=1, regenerated_versions=1, and active_transcript_id=release-gate-transcript-v2.',
        },
      );
    }
  }

  return commands;
}

export type ReleaseGateStaticEvidenceOptions = {
  repoPath: string;
  latestTranscriptRequired: boolean;
  latestRoutePresent: boolean;
  migrationText: string;
  transcriptFixtureGaps: string[];
};

export function releaseGateStaticEvidenceResultsFromOptions({
  repoPath,
  latestTranscriptRequired,
  latestRoutePresent,
  migrationText,
  transcriptFixtureGaps,
}: ReleaseGateStaticEvidenceOptions): ReleaseGateEvidenceResult[] {
  const aiGaps = workersAiBindingGaps(repoPath);
  const workerConfigGaps = workerConfigHygieneGaps(repoPath);
  const workerPackageGaps = workerPackageScaffoldGaps(repoPath);
  const results: ReleaseGateEvidenceResult[] = [];

  if (repoSourceUsesWorkersAi(repoPath) || aiGaps.length) {
    const ok = aiGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Workers AI binding configured',
      ok,
      required: true,
      reason: 'Source uses Workers AI, so the Worker must expose a real AI binding before AI-backed routes or workflows can be accepted.',
      output_summary: ok
        ? 'Wrangler config contains active Workers AI binding; TypeScript Env declarations, when present, keep AI required.'
        : undefined,
      error: ok ? undefined : aiGaps.join(' '),
    });
  }

  if (latestTranscriptRequired && latestRoutePresent && migrationText.trim()) {
    const ok = transcriptFixtureGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Latest transcript fixture schema',
      ok,
      required: true,
      reason:
        'GET /latest is present, so the local release gate must be able to seed and verify a completed regenerated transcript through D1.',
      output_summary: ok ? 'D1 schema supports seeded latest-transcript release-gate validation.' : undefined,
      error: ok ? undefined : transcriptFixtureGaps.join(' '),
    });
  }

  if (workerConfigPath(repoPath) || workerConfigGaps.length) {
    const ok = workerConfigGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Worker config hygiene',
      ok,
      required: true,
      reason:
        'Worker release requires a current Wrangler config with local schema validation, recent compatibility date, Node.js compatibility, and observability.',
      output_summary: ok ? 'Wrangler config is current, Node-compatible, and observable.' : undefined,
      error: ok ? undefined : workerConfigGaps.join(' '),
    });
  }

  if (repoLooksLikeWorkerProject(repoPath) || workerPackageGaps.length) {
    const ok = workerPackageGaps.length === 0;
    results.push({
      tier: 'api',
      command: 'static check: Worker package scaffold hygiene',
      ok,
      required: true,
      reason:
        'Worker release requires local Wrangler tooling, staging/production package scripts, vanilla frontend dependencies, and gitignored local delivery/Wrangler state.',
      output_summary: ok
        ? 'Worker package scripts and local tooling match the Worker-first release policy.'
        : undefined,
      error: ok ? undefined : workerPackageGaps.join(' '),
    });
  }

  return results;
}

export function releaseGateRequiredStaticEvidenceFailures(results: ReleaseGateEvidenceResult[]) {
  return results.filter((result) => result.required && !result.ok);
}
