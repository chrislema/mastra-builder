import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScaffoldManifest } from './schemas';

export type ScaffoldValidationResult = {
  id: string;
  check: string;
  passed: boolean;
  reason: string;
};

const pass = (id: string, reason: string): ScaffoldValidationResult => ({ id, check: id, passed: true, reason });
const fail = (id: string, reason: string): ScaffoldValidationResult => ({ id, check: id, passed: false, reason });

function readJsonFile<T>(projectFolder: string, path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(projectFolder, path), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function containsBinding(value: unknown, binding: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if ((value as { binding?: unknown }).binding === binding) return true;
  if (Array.isArray(value)) return value.some((item) => containsBinding(item, binding));
  return Object.values(value).some((item) => containsBinding(item, binding));
}

export function validateMaterializedScaffold(projectFolder: string, manifest: ScaffoldManifest): ScaffoldValidationResult[] {
  const missingFiles = manifest.generatedFiles.filter((path) => !existsSync(join(projectFolder, path)));
  const packageJson = readJsonFile<{ scripts?: Record<string, string> }>(projectFolder, 'package.json');
  const wrangler = readJsonFile<Record<string, unknown>>(projectFolder, 'wrangler.jsonc');
  const vitestConfig = existsSync(join(projectFolder, 'vitest.config.ts'))
    ? readFileSync(join(projectFolder, 'vitest.config.ts'), 'utf8')
    : '';
  const results: ScaffoldValidationResult[] = [
    missingFiles.length
      ? fail('scaffold_generated_files_present', `Missing scaffold file(s): ${missingFiles.join(', ')}`)
      : pass('scaffold_generated_files_present', 'All scaffold manifest files exist.'),
  ];

  const scriptMismatches = Object.entries(manifest.packageScripts).filter(
    ([name, command]) => packageJson?.scripts?.[name] !== command,
  );
  results.push(
    scriptMismatches.length
      ? fail(
          'scaffold_package_scripts_match',
          `package.json script mismatch: ${scriptMismatches.map(([name]) => name).join(', ')}`,
        )
      : pass('scaffold_package_scripts_match', 'package.json scripts match the scaffold manifest.'),
  );

  const missingBindings = Object.keys(manifest.bindingMap).filter((binding) => {
    if (binding === 'ASSETS') return (wrangler?.assets as { binding?: unknown } | undefined)?.binding !== 'ASSETS';
    if (binding === 'AI') return (wrangler?.ai as { binding?: unknown } | undefined)?.binding !== 'AI';
    return !containsBinding(wrangler, binding);
  });
  results.push(
    missingBindings.length
      ? fail('scaffold_bindings_match', `wrangler.jsonc missing scaffold binding(s): ${missingBindings.join(', ')}`)
      : pass('scaffold_bindings_match', 'wrangler.jsonc bindings match the scaffold manifest.'),
  );

  const missingRuntimeIncludes = manifest.testRuntimeMatrix.flatMap((rule) =>
    rule.include.filter((include) => !vitestConfig.includes(include.replace('{ts,js}', manifest.language === 'typescript' ? 'ts' : 'js'))),
  );
  results.push(
    missingRuntimeIncludes.length
      ? fail('scaffold_test_runtime_matrix_match', `vitest.config.ts missing runtime include(s): ${missingRuntimeIncludes.join(', ')}`)
      : pass('scaffold_test_runtime_matrix_match', 'Vitest projects match the scaffold runtime matrix.'),
  );
  results.push(
    /test\/\*\*\/\*\.test\.(?:ts|js)/.test(vitestConfig)
      ? fail('scaffold_test_runtime_no_broad_worker_glob', 'vitest.config.ts contains a broad test/**/*.test.* glob.')
      : pass('scaffold_test_runtime_no_broad_worker_glob', 'Vitest config avoids broad all-test runtime globs.'),
  );

  return results;
}
