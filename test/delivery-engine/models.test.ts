import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryModel,
  deliveryStructuredOutputOptions,
  missingEnvVarsForDeliveryModels,
} from '../../src/mastra/delivery-engine/models.ts';

test('delivery model uses ZAI coding plan with prompt-injected structured output', () => {
  assert.equal(deliveryModel, 'zai-coding-plan/glm-5.2');
  assert.deepEqual(deliveryStructuredOutputOptions, {
    jsonPromptInjection: true,
    errorStrategy: 'warn',
  });
  assert.deepEqual(missingEnvVarsForDeliveryModels({}), ['ZHIPU_API_KEY']);
});
