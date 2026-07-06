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

test('delivery model defaults to OpenAI GPT-5.5 with prompt-injected structured output', () => {
  assert.equal(configuredDeliveryModel({}), 'openai/gpt-5.5');
  assert.equal(configuredJudgeModel({}), 'openai/gpt-5.5');
  assert.equal(judgeModel, configuredJudgeModel());
  assert.deepEqual(deliveryStructuredOutputOptions, {
    jsonPromptInjection: true,
    errorStrategy: 'warn',
  });
  assert.deepEqual(deliveryToolStructuredOutputOptions, {
    ...deliveryStructuredOutputOptions,
    model: configuredDeliveryModel(),
  });
  assert.deepEqual(missingEnvVarsForDeliveryModels({}), ['OPENAI_API_KEY']);
});

test('delivery judge model can be configured separately from builder model', () => {
  const env = {
    DELIVERY_MODEL: 'openai/gpt-5.5',
    DELIVERY_JUDGE_MODEL: 'zai-coding-plan/glm-5.2',
  };

  assert.equal(configuredDeliveryModel(env), 'openai/gpt-5.5');
  assert.equal(configuredJudgeModel(env), 'zai-coding-plan/glm-5.2');
  assert.deepEqual(missingEnvVarsForDeliveryModels(env), ['OPENAI_API_KEY', 'ZHIPU_API_KEY']);
});
