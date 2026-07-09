import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeDeliveryScaffold } from '../../src/mastra/delivery-engine/scaffold-workflow.ts';
import {
  initializeDeliveryRunState,
  readDeliveryEventsState,
  readDeliveryRunState,
} from '../../src/mastra/delivery-engine/state-service.ts';

test('delivery scaffold workflow writes deterministic Worker scaffold and records manifest artifact', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-scaffold-'));
  writeFileSync(
    join(repoPath, 'vision.md'),
    [
      '# Vision',
      'Build a Cloudflare Worker app with Workers AI.',
      'Store runs, candidates, and transcripts for completed transcript regeneration.',
    ].join('\n'),
  );

  const run = await initializeDeliveryRunState({ repoPath, visionPath: 'vision.md' });
  const output = await executeDeliveryScaffold({ repoPath, runId: run.run_id });

  assert.equal(output.repoPath, repoPath);
  assert.equal(output.manifestPath, '.delivery/artifacts/scaffold-manifest.json');
  assert.ok(output.profileList.includes('worker-typescript'));
  assert.ok(output.profileList.includes('worker-workers-ai'));
  assert.ok(output.profileList.includes('worker-d1'));
  assert.ok(output.generatedFiles.includes('wrangler.jsonc'));
  assert.ok(output.generatedFiles.includes('test/contracts.test.ts'));
  assert.equal(output.scaffoldManifest.main, 'src/index.ts');
  assert.deepEqual(output.scaffoldManifest.validationCommands, ['npm run typecheck', 'npm test']);
  assert.deepEqual(
    output.checks.map((check) => [check.check, check.passed]),
    [
      ['scaffold_generated_files_present', true],
      ['scaffold_package_scripts_match', true],
      ['scaffold_bindings_match', true],
      ['scaffold_test_runtime_matrix_match', true],
      ['scaffold_test_runtime_no_broad_worker_glob', true],
      ['scaffold_vitest_config_typecheck', true],
    ],
  );

  assert.equal(existsSync(join(repoPath, 'package.json')), true);
  assert.equal(existsSync(join(repoPath, 'wrangler.jsonc')), true);
  assert.equal(existsSync(join(repoPath, 'public/index.html')), true);
  assert.equal(existsSync(join(repoPath, '.delivery/artifacts/scaffold-manifest.json')), true);

  const manifest = JSON.parse(readFileSync(join(repoPath, '.delivery/artifacts/scaffold-manifest.json'), 'utf8')) as {
    profileList: string[];
    testRuntimeMatrix: Array<{ name: string; runtime: string; include: string[] }>;
  };
  assert.ok(manifest.profileList.includes('worker-d1'));
  assert.equal(manifest.testRuntimeMatrix.find((rule) => rule.name === 'node')?.runtime, 'node');
  assert.ok(manifest.testRuntimeMatrix.find((rule) => rule.name === 'node')?.include.includes('test/contracts.test.{ts,js}'));

  const state = await readDeliveryRunState({ repoPath });
  assert.equal(state.artifacts['scaffold-manifest'], '.delivery/artifacts/scaffold-manifest.json');
  assert.equal(state.stage, 'scaffold');

  const events = await readDeliveryEventsState({ repoPath });
  assert.ok(events.some((event) => event.type === 'scaffold_generated'));
  assert.ok(events.some((event) => event.type === 'stage_end' && event.stage === 'scaffold'));
});
