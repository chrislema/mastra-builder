import type { ProjectLanguage } from './schemas';

export const workerToolchainVersions = {
  cloudflareVitestPoolWorkers: '0.18.2',
  jsdom: '29.1.1',
  vitest: '4.1.10',
  wrangler: '4.107.1',
  typescript: '6.0.3',
  typesNode: '26.1.0',
} as const;

export function workerToolchainDevDependencies(language: ProjectLanguage) {
  const devDependencies: Record<string, string> = {
    '@cloudflare/vitest-pool-workers': workerToolchainVersions.cloudflareVitestPoolWorkers,
    jsdom: workerToolchainVersions.jsdom,
    vitest: workerToolchainVersions.vitest,
    wrangler: workerToolchainVersions.wrangler,
  };

  if (language === 'typescript') {
    devDependencies['@types/node'] = workerToolchainVersions.typesNode;
    devDependencies.typescript = workerToolchainVersions.typescript;
  }

  return devDependencies;
}
