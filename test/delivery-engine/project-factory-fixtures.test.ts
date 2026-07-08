import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  materializeProjectScaffold,
  renderProjectScaffold,
  validateMaterializedScaffold,
  type ProjectProfile,
} from '../../src/mastra/delivery-engine/project-factory/index.ts';
import { classifyTestRuntime } from '../../src/mastra/delivery-engine/project-factory/test-runtime-matrix.ts';
import { sourcePolicyFromDocuments, type SourceDocument } from '../../src/mastra/delivery-engine/source-policy.ts';

type FixtureExpectation = {
  name: string;
  profiles: ProjectProfile[];
  bindings?: string[];
  language?: 'javascript' | 'typescript';
  pages?: boolean;
};

const fixtures: FixtureExpectation[] = [
  { name: 'minimal-worker-js', profiles: ['worker-vanilla-js'], language: 'javascript' },
  { name: 'typescript-public-ui', profiles: ['worker-typescript'], language: 'typescript' },
  { name: 'workers-ai', profiles: ['worker-typescript', 'worker-workers-ai'], bindings: ['AI'], language: 'typescript' },
  { name: 'd1', profiles: ['worker-typescript', 'worker-d1'], bindings: ['DB'], language: 'typescript' },
  { name: 'kv-r2', profiles: ['worker-typescript', 'worker-kv', 'worker-r2'], bindings: ['KV', 'ARTIFACTS'], language: 'typescript' },
  { name: 'pages-explicit', profiles: ['worker-typescript', 'pages-explicit'], pages: true, language: 'typescript' },
  {
    name: 'benchmark-shaped',
    profiles: ['worker-typescript', 'worker-workers-ai', 'worker-d1'],
    bindings: ['AI', 'DB', 'BOOKMARKS'],
    language: 'typescript',
  },
];

function fixtureDocuments(name: string): SourceDocument[] {
  const root = join(process.cwd(), 'test/fixtures/delivery-projects', name);
  return ['vision.md', 'spec.md'].flatMap((path) => {
    const fullPath = join(root, path);
    return existsSync(fullPath) ? [{ path, content: readFileSync(fullPath, 'utf8') }] : [];
  });
}

function scaffoldFile(scaffold: ReturnType<typeof renderProjectScaffold>, path: string) {
  const file = scaffold.files.find((candidate) => candidate.path === path);
  assert.ok(file, `Expected scaffold file ${path}`);
  return file.content;
}

test('delivery project fixtures generate deterministic Cloudflare Worker scaffold rails', () => {
  for (const fixture of fixtures) {
    const sourceDocuments = fixtureDocuments(fixture.name);
    const sourcePolicy = sourcePolicyFromDocuments(sourceDocuments);
    const scaffold = renderProjectScaffold({
      projectName: fixture.name,
      sourceDocuments,
      sourcePolicy,
    });
    const materializedPath = mkdtempSync(join(tmpdir(), `delivery-fixture-${fixture.name}-`));

    materializeProjectScaffold(materializedPath, scaffold);

    assert.deepEqual(scaffold.manifest.profileList, fixture.profiles, fixture.name);
    assert.equal(scaffold.manifest.language, fixture.language, fixture.name);
    assert.equal(sourcePolicy.pagesRequired, fixture.pages ?? false, fixture.name);
    assert.equal(classifyTestRuntime(`test/contracts.test.${scaffold.manifest.language === 'typescript' ? 'ts' : 'js'}`), 'node');
    assert.equal(classifyTestRuntime(`test/api-routes.test.${scaffold.manifest.language === 'typescript' ? 'ts' : 'js'}`), 'worker');
    assert.equal(classifyTestRuntime('test/frontend-shell.test.js'), 'jsdom');
    assert.deepEqual(
      validateMaterializedScaffold(materializedPath, scaffold.manifest).filter((check) => !check.passed),
      [],
      fixture.name,
    );

    const packageJson = JSON.parse(scaffoldFile(scaffold, 'package.json')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.match(packageJson.scripts.test, /^vitest run/);
    assert.equal(packageJson.dependencies?.react, undefined, fixture.name);
    assert.equal(packageJson.devDependencies?.vite, undefined, fixture.name);

    const wrangler = JSON.parse(scaffoldFile(scaffold, 'wrangler.jsonc')) as Record<string, any>;
    assert.equal(wrangler.assets?.binding, 'ASSETS', fixture.name);
    for (const binding of fixture.bindings ?? []) {
      assert.equal(scaffold.manifest.bindingMap[binding] !== undefined, true, `${fixture.name}:${binding}`);
    }
    if (fixture.bindings?.includes('AI')) {
      assert.deepEqual(wrangler.ai, { binding: 'AI' }, fixture.name);
      assert.deepEqual(wrangler.env.staging.ai, { binding: 'AI' }, fixture.name);
      assert.deepEqual(wrangler.env.production.ai, { binding: 'AI' }, fixture.name);
    }
    if (fixture.bindings?.includes('BOOKMARKS')) {
      assert.ok(wrangler.services.some((service: { binding: string }) => service.binding === 'BOOKMARKS'), fixture.name);
      assert.ok(
        wrangler.env.staging.services.some((service: { binding: string }) => service.binding === 'BOOKMARKS'),
        fixture.name,
      );
    }
  }
});
