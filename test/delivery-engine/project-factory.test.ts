import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  materializeProjectScaffold,
  renderProjectScaffold,
  selectProjectProfiles,
  validateMaterializedScaffold,
  workerToolchainVersions,
} from '../../src/mastra/delivery-engine/project-factory/index.ts';

function fileContent(scaffold: ReturnType<typeof renderProjectScaffold>, path: string) {
  const file = scaffold.files.find((candidate) => candidate.path === path);
  assert.ok(file, `Expected scaffold file ${path}`);
  return file.content;
}

test('project factory renders a TypeScript Worker scaffold with Cloudflare bindings mirrored into environments', () => {
  const scaffold = renderProjectScaffold({
    projectName: 'Talking Head Builder',
    sourceDocuments: [
      {
        path: 'vision.md',
        content: [
          'Build a Cloudflare Worker app using Workers AI.',
          'Use Cloudflare D1 for runs, Cloudflare KV for short-lived settings, and Cloudflare R2 object storage for generated artifacts.',
        ].join('\n'),
      },
    ],
    sourcePolicy: {
      pagesRequired: false,
      requiredProfileKinds: ['audience_segments', 'voice_profile'],
      latestTranscriptRequired: true,
      externalServiceBindings: ['BOOKMARKS'],
    },
  });

  assert.deepEqual(scaffold.manifest.profileList, [
    'worker-typescript',
    'worker-workers-ai',
    'worker-d1',
    'worker-kv',
    'worker-r2',
  ]);
  assert.equal(scaffold.manifest.language, 'typescript');
  assert.equal(scaffold.manifest.main, 'src/index.ts');
  assert.ok(scaffold.manifest.generatedFiles.includes('tsconfig.json'));
  assert.ok(scaffold.manifest.generatedFiles.includes('migrations/0001_app_events.sql'));
  assert.equal(scaffold.manifest.generatedFileSurfaces['src/index.ts'], 'worker');
  assert.equal(scaffold.manifest.generatedFileSurfaces['test/contracts.test.ts'], 'test');
  assert.equal(scaffold.manifest.generatedFileSurfaces['migrations/0001_app_events.sql'], 'migration');
  assert.deepEqual(scaffold.manifest.bindingMap, {
    ASSETS: 'static assets binding for ./public',
    AI: 'Workers AI binding',
    DB: 'D1 database binding',
    KV: 'KV namespace binding',
    ARTIFACTS: 'R2 bucket binding',
    BOOKMARKS: 'external Worker service binding',
  });

  const packageJson = JSON.parse(fileContent(scaffold, 'package.json')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(packageJson.scripts.dev, 'wrangler dev --env staging');
  assert.equal(packageJson.scripts.deploy, 'wrangler deploy --env production');
  assert.equal(packageJson.scripts.typecheck, 'npm run generate-types && tsc --noEmit');
  assert.equal(packageJson.devDependencies['@cloudflare/vitest-pool-workers'], workerToolchainVersions.cloudflareVitestPoolWorkers);
  assert.equal(packageJson.devDependencies.vitest, workerToolchainVersions.vitest);
  assert.equal(packageJson.devDependencies.wrangler, workerToolchainVersions.wrangler);
  assert.equal(packageJson.devDependencies.typescript, workerToolchainVersions.typescript);
  assert.equal(packageJson.devDependencies.react, undefined);
  assert.equal(packageJson.devDependencies.vite, undefined);

  const wrangler = JSON.parse(fileContent(scaffold, 'wrangler.jsonc')) as {
    ai: { binding: string };
    assets: { binding: string };
    d1_databases: Array<{ binding: string }>;
    kv_namespaces: Array<{ binding: string }>;
    r2_buckets: Array<{ binding: string }>;
    services: Array<{ binding: string }>;
    env: {
      staging: Record<string, unknown>;
      production: Record<string, unknown>;
    };
  };
  assert.deepEqual(wrangler.ai, { binding: 'AI' });
  assert.deepEqual(wrangler.assets, { directory: './public', binding: 'ASSETS' });
  assert.equal(wrangler.d1_databases[0]?.binding, 'DB');
  assert.equal(wrangler.kv_namespaces[0]?.binding, 'KV');
  assert.equal(wrangler.r2_buckets[0]?.binding, 'ARTIFACTS');
  assert.equal(wrangler.services[0]?.binding, 'BOOKMARKS');
  assert.deepEqual(wrangler.env.staging.ai, wrangler.ai);
  assert.deepEqual(wrangler.env.production.d1_databases, wrangler.d1_databases);

  const workerSource = fileContent(scaffold, 'src/index.ts');
  assert.match(workerSource, /export interface Env/);
  assert.match(workerSource, /AI: Ai;/);
  assert.match(workerSource, /DB: D1Database;/);
  assert.match(workerSource, /BOOKMARKS: Fetcher;/);
  assert.doesNotMatch(workerSource, /AI\?: Ai/);
});

test('project factory keeps a minimal plain JavaScript Worker when source asks for vanilla JS', () => {
  const profiles = selectProjectProfiles({
    projectName: 'Simple Tool',
    sourceDocuments: [{ path: 'vision.md', content: 'Use plain HTML, CSS, and JavaScript for a simple Worker app.' }],
  });
  assert.deepEqual(profiles, ['worker-vanilla-js']);

  const scaffold = renderProjectScaffold({
    projectName: 'Simple Tool',
    sourceDocuments: [{ path: 'vision.md', content: 'Use plain HTML, CSS, and JavaScript for a simple Worker app.' }],
  });

  assert.equal(scaffold.manifest.language, 'javascript');
  assert.equal(scaffold.manifest.main, 'src/index.js');
  assert.ok(scaffold.manifest.generatedFiles.includes('src/contracts.js'));
  assert.equal(scaffold.manifest.generatedFiles.includes('tsconfig.json'), false);
  assert.equal(JSON.parse(fileContent(scaffold, 'package.json')).scripts.check, 'npm test');
});

test('project factory ignores locally negated Cloudflare feature mentions', () => {
  assert.deepEqual(
    selectProjectProfiles({
      projectName: 'No Storage Worker',
      sourceDocuments: [
        {
          path: 'vision.md',
          content: 'Build a plain JavaScript Worker. Do not use R2, object storage, Workers AI, Cloudflare Pages, KV, or D1.',
        },
      ],
    }),
    ['worker-vanilla-js'],
  );
});

test('project factory materializes files only through the explicit writer helper', () => {
  const projectFolder = mkdtempSync(join(tmpdir(), 'project-factory-'));
  const scaffold = renderProjectScaffold({ projectName: 'Writable Worker' });

  assert.equal(existsSync(join(projectFolder, 'package.json')), false);
  materializeProjectScaffold(projectFolder, scaffold);

  assert.equal(JSON.parse(readFileSync(join(projectFolder, 'package.json'), 'utf8')).name, 'writable-worker');
  assert.match(readFileSync(join(projectFolder, 'public/index.html'), 'utf8'), /writable-worker/);
});

test('project factory validates materialized scaffold against the manifest', () => {
  const projectFolder = mkdtempSync(join(tmpdir(), 'project-factory-validation-'));
  const scaffold = renderProjectScaffold({ projectName: 'Validated Worker', requestedProfiles: ['worker-d1'] });
  materializeProjectScaffold(projectFolder, scaffold);

  assert.deepEqual(
    validateMaterializedScaffold(projectFolder, scaffold.manifest).map((check) => [check.check, check.passed]),
    [
      ['scaffold_generated_files_present', true],
      ['scaffold_package_scripts_match', true],
      ['scaffold_bindings_match', true],
      ['scaffold_test_runtime_matrix_match', true],
      ['scaffold_test_runtime_no_broad_worker_glob', true],
      ['scaffold_vitest_config_typecheck', true],
    ],
  );

  rmSync(join(projectFolder, 'test/contracts.test.ts'));
  const driftChecks = validateMaterializedScaffold(projectFolder, scaffold.manifest);
  assert.equal(driftChecks.find((check) => check.check === 'scaffold_generated_files_present')?.passed, false);
});

test('generated Vitest config typechecks against the pinned Worker test toolchain', () => {
  const projectFolder = mkdtempSync(join(tmpdir(), 'project-factory-vitest-typecheck-'));
  const scaffold = renderProjectScaffold({ projectName: 'Vitest Compile Worker' });
  materializeProjectScaffold(projectFolder, scaffold);
  symlinkSync(join(process.cwd(), 'node_modules'), join(projectFolder, 'node_modules'), 'dir');
  writeFileSync(
    join(projectFolder, 'tsconfig.vitest.json'),
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

  try {
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.vitest.json'], {
      cwd: projectFolder,
      stdio: 'pipe',
    });
  } catch (error) {
    const commandError = error as { message?: string; stdout?: Buffer; stderr?: Buffer };
    assert.fail(
      [
        'Generated vitest.config.ts must compile against the pinned Worker test toolchain.',
        commandError.message,
        commandError.stdout?.toString(),
        commandError.stderr?.toString(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
});

test('project factory composes workflow and admin profiles without moving away from Workers', () => {
  const scaffold = renderProjectScaffold({
    projectName: 'Workflow Admin',
    requestedProfiles: ['worker-workflows', 'worker-authenticated-admin'],
  });

  assert.deepEqual(scaffold.manifest.profileList, [
    'worker-typescript',
    'worker-workflows',
    'worker-authenticated-admin',
  ]);

  const wrangler = JSON.parse(fileContent(scaffold, 'wrangler.jsonc')) as {
    workflows: Array<{ binding: string; class_name: string }>;
    env: { staging: { workflows: unknown }; production: { workflows: unknown } };
  };
  assert.equal(wrangler.workflows[0]?.binding, 'PROCESSING_WORKFLOW');
  assert.equal(wrangler.workflows[0]?.class_name, 'ProcessingWorkflow');
  assert.deepEqual(wrangler.env.staging.workflows, wrangler.workflows);
  assert.deepEqual(wrangler.env.production.workflows, wrangler.workflows);

  assert.match(fileContent(scaffold, 'src/index.ts'), /WorkflowEntrypoint/);
  assert.match(fileContent(scaffold, 'src/index.ts'), /export class ProcessingWorkflow extends WorkflowEntrypoint/);
  assert.match(fileContent(scaffold, '.dev.vars.example'), /ADMIN_SESSION_SECRET=change-me-locally/);
});

test('project factory treats Pages as an explicit exception profile only', () => {
  assert.equal(
    selectProjectProfiles({
      projectName: 'Default Worker',
      sourceDocuments: [{ path: 'vision.md', content: 'Build this as a Worker. Do not use Cloudflare Pages.' }],
      sourcePolicy: { pagesRequired: false, requiredProfileKinds: [], latestTranscriptRequired: false, externalServiceBindings: [] },
    }).includes('pages-explicit'),
    false,
  );

  assert.deepEqual(
    selectProjectProfiles({
      projectName: 'Explicit Pages',
      sourcePolicy: { pagesRequired: true, requiredProfileKinds: [], latestTranscriptRequired: false, externalServiceBindings: [] },
    }),
    ['worker-typescript', 'pages-explicit'],
  );
});

test('project factory maps benchmark-shaped transcript persistence to D1 rails', () => {
  const scaffold = renderProjectScaffold({
    projectName: 'Talking Head Builder',
    sourceDocuments: [
      {
        path: 'spec.md',
        content: 'Store runs, candidates, and transcripts for completed transcript regeneration.',
      },
    ],
    sourcePolicy: {
      pagesRequired: false,
      requiredProfileKinds: ['audience_segments', 'voice_profile'],
      latestTranscriptRequired: true,
      externalServiceBindings: [],
    },
  });

  assert.ok(scaffold.manifest.profileList.includes('worker-d1'));
  assert.ok(scaffold.manifest.generatedFiles.includes('migrations/0001_app_events.sql'));
  assert.match(fileContent(scaffold, 'wrangler.jsonc'), /"binding": "DB"/);
});
