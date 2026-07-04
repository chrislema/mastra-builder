import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeliveryRequestContext } from '../../src/mastra/delivery-engine/context.ts';
import { initializeDeliveryRun } from '../../src/mastra/delivery-engine/state.ts';
import { deliveryStateTools } from '../../src/mastra/delivery-engine/tools.ts';

test('delivery state tools expose native persistence names with compatibility aliases', () => {
  assert.equal(Object.keys(deliveryStateTools).includes('persistDeliveryStateTool'), true);
  assert.equal(Object.keys(deliveryStateTools).includes('listDeliveryStateRecordsTool'), true);
  assert.equal(Object.keys(deliveryStateTools).includes('mirrorDeliveryStateTool'), true);
  assert.equal(Object.keys(deliveryStateTools).includes('listDeliveryStateMirrorsTool'), true);
  assert.equal(deliveryStateTools.persistDeliveryStateTool.id, 'persist-delivery-state');
  assert.equal(deliveryStateTools.listDeliveryStateRecordsTool.id, 'list-delivery-state-records');
  assert.equal(deliveryStateTools.mirrorDeliveryStateTool.id, 'mirror-delivery-state');
  assert.equal(deliveryStateTools.listDeliveryStateMirrorsTool.id, 'list-delivery-state-mirrors');
});

test('repo-bound delivery tools can resolve repoPath from request context', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'delivery-tool-context-'));
  writeFileSync(join(repoPath, 'vision.md'), '# Vision\n');
  writeFileSync(join(repoPath, 'spec.md'), '# Spec\n');
  const run = initializeDeliveryRun({ repoPath, visionPath: 'vision.md', specPath: 'spec.md' });

  const status = await deliveryStateTools.getDeliveryRunStatusTool.execute?.(
    {},
    { requestContext: createDeliveryRequestContext(repoPath) } as any,
  );

  assert.equal(status?.run_id, run.run_id);
  assert.equal(status?.stage, 'readout');
});
