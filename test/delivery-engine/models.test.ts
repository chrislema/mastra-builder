import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredDeliveryModel,
  configuredJudgeModel,
  deliveryStructuredOutputOptions,
  deliveryToolStructuredOutputOptions,
  judgeModel,
  missingEnvVarsForDeliveryModels,
} from '../../src/mastra/delivery-engine/models.ts';

test('delivery model defaults to ZAI coding plan with prompt-injected structured output', () => {
  assert.equal(configuredDeliveryModel({}), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredJudgeModel({}), 'zai-coding-plan/glm-5.2');
  assert.equal(judgeModel, configuredJudgeModel());
  assert.deepEqual(deliveryStructuredOutputOptions, {
    jsonPromptInjection: true,
    errorStrategy: 'warn',
  });
  assert.deepEqual(deliveryToolStructuredOutputOptions, {
    ...deliveryStructuredOutputOptions,
    model: configuredDeliveryModel(),
  });
  assert.deepEqual(missingEnvVarsForDeliveryModels({}), ['ZHIPU_API_KEY']);
});

test('delivery judge model can be configured separately from builder model', () => {
  const env = {
    DELIVERY_MODEL: 'zai-coding-plan/glm-5.2',
    DELIVERY_JUDGE_MODEL: 'openai/gpt-5.1',
  };

  assert.equal(configuredDeliveryModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredJudgeModel(env), 'openai/gpt-5.1');
  assert.deepEqual(missingEnvVarsForDeliveryModels(env), ['ZHIPU_API_KEY', 'OPENAI_API_KEY']);
});
