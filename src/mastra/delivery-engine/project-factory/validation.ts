import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function projectRootWithValidationToolchain() {
  const candidates = [
    process.env.MASTRA_PROJECT_ROOT,
    process.env.SKILLS_BASE_DIR,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.map((candidate) => resolve(candidate)).find((candidate) =>
    existsSync(join(candidate, 'node_modules/typescript/bin/tsc')) &&
    existsSync(join(candidate, 'node_modules/@cloudflare/vitest-pool-workers')) &&
    existsSync(join(candidate, 'node_modules/vitest')),
  );
}

function validateVitestConfigTypecheck(projectFolder: string): ScaffoldValidationResult {
  const vitestConfigPath = join(projectFolder, 'vitest.config.ts');
  if (!existsSync(vitestConfigPath)) return fail('scaffold_vitest_config_typecheck', 'vitest.config.ts is missing.');

  const toolchainRoot = projectRootWithValidationToolchain();
  if (!toolchainRoot) {
    return fail(
      'scaffold_vitest_config_typecheck',
      'Scaffold validation toolchain is missing; install the pinned project-factory Cloudflare/Vitest dev dependencies.',
    );
  }

  const tempProject = mkdtempSync(join(tmpdir(), 'scaffold-vitest-typecheck-'));
  try {
    copyFileSync(vitestConfigPath, join(tempProject, 'vitest.config.ts'));
    symlinkSync(join(toolchainRoot, 'node_modules'), join(tempProject, 'node_modules'), 'dir');
    writeFileSync(
      join(tempProject, 'tsconfig.vitest.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ES2022',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
            types: ['node'],
            noEmit: true,
          },
          include: ['vitest.config.ts'],
        },
        null,
        2,
      ),
    );
    execFileSync(process.execPath, [join(toolchainRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.vitest.json'], {
      cwd: tempProject,
      stdio: 'pipe',
    });
    return pass('scaffold_vitest_config_typecheck', 'vitest.config.ts typechecks against the pinned Worker test toolchain.');
  } catch (error) {
    const commandError = error as { message?: string; stdout?: Buffer; stderr?: Buffer };
    const diagnostic = [commandError.stdout?.toString(), commandError.stderr?.toString(), commandError.message]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200);
    return fail('scaffold_vitest_config_typecheck', `vitest.config.ts failed typecheck: ${diagnostic}`);
  } finally {
    rmSync(tempProject, { recursive: true, force: true });
  }
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
  results.push(validateVitestConfigTypecheck(projectFolder));

  return results;
}
