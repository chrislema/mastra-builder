import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workerConfigPath } from '../worker-hygiene';

export const releaseGateLocalAdminToken = 'release-gate-local-admin-token';

function parseDevVarsValue(text: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
  if (!match) return undefined;
  const raw = match[1].trim();
  const quoted = /^["'](.*)["']$/.exec(raw);
  return quoted ? quoted[1] : raw;
}

function releaseGateLocalWorkerEnvironment(repoPath: string) {
  return workerConfigPath(repoPath) ? 'staging' : undefined;
}

export function releaseGateLocalAdminSecretPath(repoPath: string) {
  const root = resolve(repoPath);
  const environmentName = releaseGateLocalWorkerEnvironment(repoPath);
  const candidates = environmentName
    ? [
        `.dev.vars.${environmentName}`,
        '.dev.vars',
        `.env.${environmentName}.local`,
        '.env.local',
        `.env.${environmentName}`,
        '.env',
      ]
    : ['.dev.vars', '.env.local', '.env'];
  const existing = candidates.find((file) => existsSync(join(root, file)));

  return join(root, existing ?? (environmentName ? `.dev.vars.${environmentName}` : '.dev.vars'));
}

export function prepareReleaseGateLocalAdminSecret(repoPath: string) {
  const devVarsPath = releaseGateLocalAdminSecretPath(repoPath);
  if (existsSync(devVarsPath)) {
    const original = readFileSync(devVarsPath, 'utf8');
    const existingToken = parseDevVarsValue(original, 'ADMIN_TOKEN');
    if (existingToken) return { token: existingToken, restore: () => undefined };

    writeFileSync(devVarsPath, `${original.replace(/\s*$/, '\n')}ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
    return {
      token: releaseGateLocalAdminToken,
      restore: () => writeFileSync(devVarsPath, original),
    };
  }

  writeFileSync(devVarsPath, `ADMIN_TOKEN=${releaseGateLocalAdminToken}\n`);
  return {
    token: releaseGateLocalAdminToken,
    restore: () => {
      if (existsSync(devVarsPath)) unlinkSync(devVarsPath);
    },
  };
}
