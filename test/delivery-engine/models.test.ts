import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredArchitectModel,
  configuredDeliveryModel,
  configuredDesignerModel,
  configuredEngineerModel,
  configuredExecutionModel,
  configuredJudgeModel,
  configuredPlanningModel,
  configuredTesterModel,
  deliveryStructuredOutputOptions,
  deliveryToolStructuredOutputOptions,
  plannerModel,
  judgeModel,
  missingEnvVarsForDeliveryModels,
} from '../../src/mastra/delivery-engine/models.ts';

test('delivery model defaults to OpenAI GPT-5.5 with prompt-injected structured output', () => {
  assert.equal(configuredDeliveryModel({}), 'openai/gpt-5.5');
  assert.equal(configuredPlanningModel({}), 'openai/gpt-5.5');
  assert.equal(configuredArchitectModel({}), 'openai/gpt-5.5');
  assert.equal(configuredExecutionModel({}), 'openai/gpt-5.5');
  assert.equal(configuredEngineerModel({}), 'openai/gpt-5.5');
  assert.equal(configuredDesignerModel({}), 'openai/gpt-5.5');
  assert.equal(configuredTesterModel({}), 'openai/gpt-5.5');
  assert.equal(configuredJudgeModel({}), 'openai/gpt-5.5');
  assert.equal(plannerModel, configuredPlanningModel());
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
  assert.deepEqual(missingEnvVarsForDeliveryModels({ OPENAI_API_KEY: 'your-openai-api-key' }), ['OPENAI_API_KEY']);
});

test('delivery execution model can be moved to GLM while planner and architect stay strong', () => {
  const env = {
    DELIVERY_MODEL: 'openai/gpt-5.5',
    DELIVERY_EXECUTION_MODEL: 'zai-coding-plan/glm-5.2',
  };

  assert.equal(configuredPlanningModel(env), 'openai/gpt-5.5');
  assert.equal(configuredArchitectModel(env), 'openai/gpt-5.5');
  assert.equal(configuredEngineerModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredDesignerModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredTesterModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredJudgeModel(env), 'openai/gpt-5.5');
  assert.deepEqual(missingEnvVarsForDeliveryModels(env), ['OPENAI_API_KEY', 'ZHIPU_API_KEY']);
});

test('delivery role model env vars can override the execution model per role', () => {
  const env = {
    DELIVERY_MODEL: 'openai/gpt-5.5',
    DELIVERY_EXECUTION_MODEL: 'zai-coding-plan/glm-5.2',
    DELIVERY_TESTER_MODEL: 'openai/gpt-5.5',
  };

  assert.equal(configuredEngineerModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredDesignerModel(env), 'zai-coding-plan/glm-5.2');
  assert.equal(configuredTesterModel(env), 'openai/gpt-5.5');
});

test('delivery judge model can be configured separately from builder model', () => {
  const env = {
    DELIVERY_MODEL: 'openai/gpt-5.5',
    DELIVERY_JUDGE_MODEL: 'zai-coding-plan/glm-5.2',
  };

  assert.equal(configuredDeliveryModel(env), 'openai/gpt-5.5');
  assert.equal(configuredJudgeModel(env), 'zai-coding-plan/glm-5.2');
  assert.deepEqual(missingEnvVarsForDeliveryModels(env), ['OPENAI_API_KEY', 'ZHIPU_API_KEY']);
  assert.deepEqual(
    missingEnvVarsForDeliveryModels({
      ...env,
      OPENAI_API_KEY: 'your-openai-api-key',
      ZHIPU_API_KEY: 'your-zai-api-key',
    }),
    ['OPENAI_API_KEY', 'ZHIPU_API_KEY'],
  );
});
