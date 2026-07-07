import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type EnvLike = Record<string, string | undefined>;

export const deliveryMastraStorageId = 'builders-delivery-storage';
export const deliveryMastraObservabilityServiceName = 'builders-delivery-engine';
export const legacyDeliveryMastraObservabilityServiceName = 'builders';

export function getDeliveryMastraStorageUrl(env: EnvLike = process.env) {
  const configuredUrl = env.MASTRA_STORAGE_URL?.trim();
  if (configuredUrl) return configuredUrl;

  const configuredPath = env.MASTRA_STORAGE_PATH?.trim() || '.mastra/builders.db';
  return `file:${resolve(process.cwd(), configuredPath)}`;
}

export function ensureLocalMastraStorageDirectory(storageUrl: string) {
  if (!storageUrl.startsWith('file:')) return;

  const filePath = storageUrl.slice('file:'.length);
  if (!filePath || filePath === ':memory:') return;

  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}
