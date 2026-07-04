import assert from 'node:assert/strict';
import test from 'node:test';
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
