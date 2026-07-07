import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  deliveryMastraObservabilityServiceName,
  deliveryMastraStorageId,
  ensureLocalMastraStorageDirectory,
  getDeliveryMastraStorageUrl,
  legacyDeliveryMastraObservabilityServiceName,
} from '../src/mastra/config.ts';

test('Mastra runtime config uses explicit delivery identities', () => {
  assert.equal(deliveryMastraStorageId, 'builders-delivery-storage');
  assert.equal(deliveryMastraObservabilityServiceName, 'builders-delivery-engine');
  assert.equal(legacyDeliveryMastraObservabilityServiceName, 'builders');
});

test('Mastra storage defaults to an explicit repo-local runtime database', () => {
  assert.equal(getDeliveryMastraStorageUrl({}), `file:${resolve(process.cwd(), '.mastra/builders.db')}`);
});

test('Mastra storage URL env overrides the default runtime database', () => {
  assert.equal(
    getDeliveryMastraStorageUrl({
      MASTRA_STORAGE_URL: ' file:/tmp/custom-mastra.db ',
      MASTRA_STORAGE_PATH: 'ignored.db',
    }),
    'file:/tmp/custom-mastra.db',
  );
});

test('Mastra storage path env resolves to an absolute file URL', () => {
  assert.equal(
    getDeliveryMastraStorageUrl({ MASTRA_STORAGE_PATH: 'tmp/local-mastra.db' }),
    `file:${resolve(process.cwd(), 'tmp/local-mastra.db')}`,
  );
});

test('local file storage directory is created before LibSQL opens the database', () => {
  const storagePath = join(mkdtempSync(join(tmpdir(), 'delivery-mastra-storage-')), 'nested', 'mastra.db');
  ensureLocalMastraStorageDirectory(`file:${storagePath}`);

  assert.equal(existsSync(dirname(storagePath)), true);
});
