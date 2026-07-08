import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  materializeProjectScaffold,
  renderProjectScaffold,
  selectProjectProfiles,
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
  assert.deepEqual(scaffold.manifest.bindingMap, {
    ASSETS: 'static assets binding for ./public',
    AI: 'Workers AI binding',
    DB: 'D1 database binding',
    KV: 'KV namespace binding',
    ARTIFACTS: 'R2 bucket binding',
  });

  const packageJson = JSON.parse(fileContent(scaffold, 'package.json')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(packageJson.scripts.dev, 'wrangler dev --env staging');
  assert.equal(packageJson.scripts.deploy, 'wrangler deploy --env production');
  assert.equal(packageJson.scripts.typecheck, 'npm run generate-types && tsc --noEmit');
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

test('project factory materializes files only through the explicit writer helper', () => {
  const projectFolder = mkdtempSync(join(tmpdir(), 'project-factory-'));
  const scaffold = renderProjectScaffold({ projectName: 'Writable Worker' });

  assert.equal(existsSync(join(projectFolder, 'package.json')), false);
  materializeProjectScaffold(projectFolder, scaffold);

  assert.equal(JSON.parse(readFileSync(join(projectFolder, 'package.json'), 'utf8')).name, 'writable-worker');
  assert.match(readFileSync(join(projectFolder, 'public/index.html'), 'utf8'), /writable-worker/);
});
