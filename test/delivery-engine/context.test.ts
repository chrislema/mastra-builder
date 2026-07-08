import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import {
  createDeliveryControlRequestContext,
  createDeliveryRequestContext,
  deliveryRepoPathFromRequestContext,
  deliveryRequestContextSchema,
  requestContextAllowsDeliveryControlPrompt,
} from '../../src/mastra/delivery-engine/context.ts';
import { deliveryWorkspace } from '../../src/mastra/delivery-engine/workspace.ts';

test('delivery request context schema requires repoPath', () => {
  assert.equal(deliveryRequestContextSchema.safeParse({ repoPath: '/tmp/project' }).success, true);
  assert.equal(deliveryRequestContextSchema.safeParse({}).success, false);
});

test('delivery request context helper resolves repoPath consistently', () => {
  const context = createDeliveryRequestContext('/tmp/project');
  assert.equal(context.get('repoPath'), resolve('/tmp/project'));
  assert.equal(deliveryRepoPathFromRequestContext(context), resolve('/tmp/project'));
  assert.equal(requestContextAllowsDeliveryControlPrompt(context), false);
});

test('delivery control request context helper marks workflow-authored prompts', () => {
  const context = createDeliveryControlRequestContext('/tmp/project');
  assert.equal(context.get('repoPath'), resolve('/tmp/project'));
  assert.equal(deliveryRepoPathFromRequestContext(context), resolve('/tmp/project'));
  assert.equal(requestContextAllowsDeliveryControlPrompt(context), true);
  assert.equal(requestContextAllowsDeliveryControlPrompt(new RequestContext([['repoPath', '/tmp/project']])), false);
});

test('delivery workspace fails closed without repoPath request context', async () => {
  await assert.rejects(
    deliveryWorkspace.resolveFilesystem({ requestContext: new RequestContext() }),
    /repoPath/,
  );

  const filesystem = await deliveryWorkspace.resolveFilesystem({
    requestContext: createDeliveryRequestContext('/tmp/project'),
  });
  assert.equal(Boolean(filesystem), true);
});
