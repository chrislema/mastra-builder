import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compactDiagnostic } from '../agent-runtime/diagnostics';
import {
  buildVerificationCommandPlan as buildVerificationCommandPlanBase,
  buildVerificationCommandPlans as buildVerificationCommandPlansBase,
} from '../build-deployment-policy';
import { missingInstalledPackageNames } from '../implementation/task-boundaries';
import {
  applyBuildVerificationRepair,
  staleWorkspaceVerificationRemediation,
} from '../implementation/retry-runtime';
import { appendDeliveryEventState } from '../state-service';
import type { TaskPlan } from '../workflow-schemas';
import { commandFailureSummary, execFileAsync, recordRunCodeStart } from './command-runner';

export function buildVerificationCommandPlan(repoPath: string) {
  return buildVerificationCommandPlanBase(repoPath);
}

export function buildVerificationCommandPlans(repoPath: string) {
  return buildVerificationCommandPlansBase(repoPath);
}

export async function ensureNodeDependencies({
  repoPath,
  mastra,
  stage,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
}): Promise<{ command: string; ok: boolean; reason: string; output_summary?: string; error?: string } | undefined> {
  const root = resolve(repoPath);
  const packagePath = join(root, 'package.json');
  const packageLockPath = join(root, 'package-lock.json');
  const nodeModulesPath = join(root, 'node_modules');
  if (!existsSync(packagePath)) return undefined;
  const missingPackages = missingInstalledPackageNames(repoPath);
  if (existsSync(nodeModulesPath) && existsSync(packageLockPath)) {
    try {
      if (statSync(packageLockPath).mtimeMs >= statSync(packagePath).mtimeMs && missingPackages.length === 0) {
        return undefined;
      }
    } catch {
      // Fall through to npm install when mtimes cannot be read.
    }
  }

  const command = 'npm install --include=dev';
  const reason = missingPackages.length
    ? `Node dependencies were missing before local validation (${missingPackages.slice(0, 8).join(', ')}${missingPackages.length > 8 ? ', ...' : ''}), so npm install --include=dev is required evidence.`
    : 'Node dependencies were missing or stale before local validation, so npm install --include=dev is required evidence.';
  await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: 180_000 });
  try {
    const result = await execFileAsync('npm', ['install', '--include=dev'], {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 1_000_000,
      env: { ...process.env, NODE_ENV: 'development', npm_config_production: 'false' },
    });
    const outputSummary = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: true,
        output_summary: outputSummary,
      },
    });
    return {
      command,
      ok: true,
      reason,
      output_summary: outputSummary,
    };
  } catch (error) {
    const failure = commandFailureSummary(error, 1000);
    await appendDeliveryEventState({
      repoPath,
      mastra,
      event: {
        type: 'run_code',
        stage,
        command,
        ok: false,
        error: failure,
      },
    });
    return {
      command,
      ok: false,
      reason,
      error: failure,
    };
  }
}

export async function runBuildVerification({
  repoPath,
  mastra,
  stage,
  taskPlan,
  taskIndex,
  allowRepair = true,
}: {
  repoPath: string;
  mastra: any;
  stage: string;
  taskPlan?: TaskPlan;
  taskIndex?: number;
  allowRepair?: boolean;
}) {
  const verificationCommands = buildVerificationCommandPlans(repoPath);
  if (!verificationCommands.length) {
    return {
      performed: [] as string[],
      missing: ['No package verification script or Wrangler config found for this build task.'],
    };
  }

  await ensureNodeDependencies({ repoPath, mastra, stage });

  const performed: string[] = [];
  for (const verificationCommand of verificationCommands) {
    const command = verificationCommand.command;
    await recordRunCodeStart({ repoPath, mastra, stage, command, timeoutMs: verificationCommand.timeoutMs });
    try {
      const result = await execFileAsync(verificationCommand.executable, verificationCommand.args, {
        cwd: resolve(repoPath),
        timeout: verificationCommand.timeoutMs,
        maxBuffer: 1_000_000,
        env: process.env,
      });
      const outputSummary = compactDiagnostic(`${result.stdout}\n${result.stderr}`, 500);
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event: {
          type: 'run_code',
          stage,
          command,
          ok: true,
          output_summary: outputSummary,
        },
      });
      performed.push(outputSummary ? `${command} passed: ${outputSummary}` : `${command} passed`);
    } catch (error) {
      const failure = commandFailureSummary(error, 1000);
      await appendDeliveryEventState({
        repoPath,
        mastra,
        event: {
          type: 'run_code',
          stage,
          command,
          ok: false,
          error: failure,
        },
      });

      if (allowRepair && (await applyBuildVerificationRepair({ repoPath, mastra, stage, taskPlan, taskIndex, failure }))) {
        return runBuildVerification({ repoPath, mastra, stage, taskPlan, taskIndex, allowRepair: false });
      }

      const staleWorkspaceFailure = staleWorkspaceVerificationRemediation({ repoPath, taskPlan, failure });
      if (staleWorkspaceFailure) {
        return {
          performed,
          missing: [`${command} failed: ${staleWorkspaceFailure}`],
        };
      }

      return {
        performed,
        missing: [`${command} failed: ${commandFailureSummary(error, 600)}`],
      };
    }
  }

  return {
    performed,
    missing: [] as string[],
  };
}
