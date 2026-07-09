import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTestRuntime,
  renderProjectScaffold,
  testRuntimeMatrixForProfiles,
} from '../../src/mastra/delivery-engine/project-factory/index.ts';

test('test runtime classifier keeps contract tests out of the Workers pool', () => {
  assert.equal(classifyTestRuntime('test/contracts.test.ts'), 'node');
  assert.equal(classifyTestRuntime('test/validation.test.ts'), 'node');
  assert.equal(classifyTestRuntime('test/domain.test.ts'), 'node');
  assert.equal(classifyTestRuntime('test/api-routes.test.ts'), 'worker');
  assert.equal(classifyTestRuntime('test/provider-adapters.test.ts'), 'worker');
  assert.equal(classifyTestRuntime('test/worker-smoke.test.ts'), 'worker');
  assert.equal(classifyTestRuntime('test/frontend-shell.test.js'), 'jsdom');
  assert.equal(classifyTestRuntime('test/ui-state.test.js'), 'jsdom');
});

test('test runtime matrix encodes separate Node, Worker, and jsdom projects', () => {
  const matrix = testRuntimeMatrixForProfiles(['worker-typescript']);

  assert.deepEqual(
    matrix.map((rule) => [rule.name, rule.runtime]),
    [
      ['node', 'node'],
      ['worker', 'worker'],
      ['frontend', 'jsdom'],
    ],
  );
  assert.ok(matrix.find((rule) => rule.name === 'node')?.include.includes('test/contracts.test.{ts,js}'));
  assert.ok(matrix.find((rule) => rule.name === 'worker')?.include.includes('test/worker-smoke.test.{ts,js}'));
});

test('generated Vitest config uses Cloudflare worker plugin only for worker tests', () => {
  const scaffold = renderProjectScaffold({
    projectName: 'Runtime Matrix',
    language: 'typescript',
    requestedProfiles: ['worker-typescript'],
  });
  const vitestConfig = scaffold.files.find((file) => file.path === 'vitest.config.ts')?.content ?? '';

  assert.match(vitestConfig, /cloudflareTest/);
  assert.match(vitestConfig, /name: 'node'/);
  assert.match(vitestConfig, /include: \["test\/contracts\.test\.ts"/);
  assert.match(vitestConfig, /name: 'worker'/);
  assert.match(vitestConfig, /include: \["test\/api-routes\.test\.ts"/);
  assert.match(vitestConfig, /name: 'frontend'/);
  assert.match(vitestConfig, /environment: 'jsdom'/);
  assert.match(vitestConfig, /passWithNoTests: true/);
  assert.doesNotMatch(vitestConfig, /name: 'node'[\s\S]*?passWithNoTests: true/);
  assert.doesNotMatch(vitestConfig, /name: 'worker'[\s\S]*?passWithNoTests: true/);
  assert.doesNotMatch(vitestConfig, /name: 'frontend'[\s\S]*?passWithNoTests: true/);
  assert.doesNotMatch(vitestConfig, /test\/\*\*\/\*\.test\.ts/);
  assert.doesNotMatch(vitestConfig, /@cloudflare\/vitest-pool-workers\/config/);
});
