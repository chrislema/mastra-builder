import type { ProjectLanguage } from './schemas';
import { workerToolchainDevDependencies } from './toolchain';

export function packageScriptsForLanguage(language: ProjectLanguage) {
  const scripts: Record<string, string> = {
    dev: 'wrangler dev --env staging',
    deploy: 'wrangler deploy --env production',
    test: 'vitest run --passWithNoTests',
    'test:node': 'vitest run --project node --passWithNoTests',
    'test:worker': 'vitest run --project worker --passWithNoTests',
    'test:frontend': 'vitest run --project frontend --passWithNoTests',
  };

  if (language === 'typescript') {
    scripts['generate-types'] = 'wrangler types';
    scripts.typecheck = 'npm run generate-types && tsc --noEmit';
    scripts.check = 'npm run typecheck && npm test';
  } else {
    scripts.check = 'npm test';
  }

  return scripts;
}

export function renderPackageJson(projectName: string, language: ProjectLanguage) {
  return `${JSON.stringify(
    {
      name: projectName,
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: packageScriptsForLanguage(language),
      devDependencies: workerToolchainDevDependencies(language),
    },
    null,
    2,
  )}\n`;
}
