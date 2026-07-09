import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptanceContractsForTask } from '../../src/mastra/delivery-engine/implementation/evidence.ts';
import type { Task } from '../../src/mastra/delivery-engine/workflow-schemas.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T02',
    owner: 'engineer',
    deliverable: 'Worker runtime config',
    depends_on: [],
    acceptance_criteria: [],
    owned_surfaces: ['wrangler.jsonc', 'package.json'],
    ...overrides,
  };
}

function writeWorkerConfig(repoPath: string, compatibilityDate: string) {
  writeFileSync(
    join(repoPath, 'wrangler.jsonc'),
    JSON.stringify(
      {
        main: 'src/index.ts',
        compatibility_date: compatibilityDate,
      },
      null,
      2,
    ),
  );
}

function writePackageJson(repoPath: string) {
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          dev: 'wrangler dev --env staging',
          deploy: 'wrangler deploy --env production',
        },
      },
      null,
      2,
    ),
  );
}

test('wrangler main and compatibility_date contracts use structured config evidence', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-wrangler-config-contract-'));
  writeWorkerConfig(repoPath, '2026-07-01');
  writePackageJson(repoPath);
  const [contract] = acceptanceContractsForTask({
    repoPath,
    task: task({
      acceptance_criteria: ['wrangler.jsonc uses main "src/index.ts" and compatibility_date "2026-07-09".'],
    }),
    verification: { performed: [], missing: [] },
  });

  assert.equal(contract.status, 'unverified');
  assert.match(contract.gaps.join('\n'), /compatibility_date must be "2026-07-09"/);

  writeWorkerConfig(repoPath, '2026-07-09');
  const [fixed] = acceptanceContractsForTask({
    repoPath,
    task: task({
      acceptance_criteria: ['wrangler.jsonc uses main "src/index.ts" and compatibility_date "2026-07-09".'],
    }),
    verification: { performed: [], missing: [] },
  });

  assert.equal(fixed.status, 'verified');
  assert.match(fixed.evidence.join('\n'), /structured wrangler\.jsonc evidence/);
});

test('package script shorthand contracts use exact structured script evidence', () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-package-script-contract-'));
  writeWorkerConfig(repoPath, '2026-07-09');
  writePackageJson(repoPath);
  const [contract] = acceptanceContractsForTask({
    repoPath,
    task: task({
      acceptance_criteria: [
        'package.json keeps Wrangler-based scripts with dev as "wrangler dev --env staging" and deploy as "wrangler deploy --env production".',
      ],
    }),
    verification: { performed: [], missing: [] },
  });

  assert.equal(contract.status, 'verified');
  assert.match(contract.evidence.join('\n'), /structured package\.json evidence verified scripts\.dev/);
  assert.match(contract.evidence.join('\n'), /structured package\.json evidence verified scripts\.deploy/);
});
