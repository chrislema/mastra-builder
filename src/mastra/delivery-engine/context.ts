import { resolve } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

export const deliveryRequestContextSchema = z.object({
  repoPath: z.string().min(1).describe('Absolute path to the target repository workspace.'),
});

export type DeliveryRequestContext = z.infer<typeof deliveryRequestContextSchema>;

function contextValue(requestContext: unknown, key: string) {
  const ctx = requestContext as { get?: (name: string) => unknown; [name: string]: unknown } | undefined;
  if (typeof ctx?.get === 'function') return ctx.get(key);
  return ctx?.[key];
}

export function deliveryRepoPathFromRequestContext(requestContext: unknown) {
  const parsed = deliveryRequestContextSchema.parse({
    repoPath: contextValue(requestContext, 'repoPath'),
  });
  return resolve(parsed.repoPath);
}

export function createDeliveryRequestContext(repoPath: string) {
  return new RequestContext([['repoPath', resolve(repoPath)]]);
}
