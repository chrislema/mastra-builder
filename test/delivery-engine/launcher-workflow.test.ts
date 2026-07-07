import assert from 'node:assert/strict';
import test from 'node:test';
import { zodToJsonSchema } from '@mastra/core/utils/zod-to-json';
import {
  deliveryStartInputSchema,
  deliveryStartWorkflow,
} from '../../src/mastra/delivery-engine/launcher-workflow.ts';

test('delivery-start facade exposes only projectFolder as required input', () => {
  const jsonSchema = zodToJsonSchema(deliveryStartInputSchema) as {
    required?: string[];
    properties?: Record<string, { type?: string; description?: string }>;
  };

  assert.equal(deliveryStartWorkflow.id, 'delivery-start');
  assert.deepEqual(jsonSchema.required, ['projectFolder']);
  assert.deepEqual(Object.keys(jsonSchema.properties ?? {}), ['projectFolder']);
  assert.equal(jsonSchema.properties?.projectFolder?.type, 'string');
  assert.match(jsonSchema.properties?.projectFolder?.description ?? '', /only required field/i);
  assert.equal(deliveryStartWorkflow.stateSchema, undefined);
});
