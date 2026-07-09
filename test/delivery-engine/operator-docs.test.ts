import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deliveryApiRoutes } from '../../src/mastra/delivery-engine/routes.ts';

const readText = (path: string) => readFileSync(path, 'utf8');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('README operator commands match package scripts and registered API routes', () => {
  const readme = readText('README.md');
  const packageJson = JSON.parse(readText('package.json')) as { scripts: Record<string, string> };

  for (const script of ['dev', 'delivery:run', 'typecheck', 'ci:delivery', 'build']) {
    assert.equal(typeof packageJson.scripts[script], 'string', `${script} script must exist`);
    assert.match(readme, new RegExp(escapeRegExp(`npm run ${script}`)), `README should document npm run ${script}`);
  }
  assert.equal(typeof packageJson.scripts.test, 'string', 'test script must exist');
  assert.match(readme, /\bnpm test\b/, 'README should document npm test');

  for (const route of deliveryApiRoutes) {
    const publicApiPath = `/api${route.path}`;
    assert.match(readme, new RegExp(escapeRegExp(publicApiPath)), `README should document ${publicApiPath}`);
  }

  assert.match(readme, /deliveryStartWorkflow/);
  assert.match(readme, /deliveryWorkflow/);
  assert.match(readme, /fresh scaffold[\s\S]+`wrangler types`/);
  assert.match(readme, /generated types already exist[\s\S]+`wrangler types --check`/);
});

test('run observation journal has outcomes or stop decisions for started delivery runs', () => {
  const journal = readText('docs/RUN_OBSERVATIONS.md');
  const sections = journal
    .split(/^### /m)
    .slice(1)
    .map((section) => {
      const [title = '', ...bodyLines] = section.split('\n');
      return { title: title.trim(), body: bodyLines.join('\n') };
    });

  const incompleteStartedRuns = sections
    .filter(({ title }) => title.includes('Started'))
    .filter(({ body }) => !/- Result:/.test(body) && !/- Stop decision:/.test(body))
    .map(({ title }) => title);

  assert.deepEqual(incompleteStartedRuns, []);
});
