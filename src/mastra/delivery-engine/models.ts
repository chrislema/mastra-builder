export const deliveryModel = 'zai-coding-plan/glm-5.2';
export const judgeModel = deliveryModel;
export const deliveryStructuredOutputOptions = {
  jsonPromptInjection: true,
} as const;

const providerApiKeyEnvVars: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  zai: ['ZHIPU_API_KEY'],
  'zai-coding-plan': ['ZHIPU_API_KEY'],
  zhipuai: ['ZHIPU_API_KEY'],
  'zhipuai-coding-plan': ['ZHIPU_API_KEY'],
};

const placeholderValues = new Set(['your-api-key', 'your_api_key', 'changeme', 'change-me']);

const isConfiguredEnvValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  return Boolean(trimmed && !placeholderValues.has(trimmed.toLowerCase()));
};

export function requiredEnvVarsForModel(model: string) {
  const provider = model.split('/')[0] ?? '';
  return providerApiKeyEnvVars[provider] ?? [];
}

export function missingEnvVarsForDeliveryModels(env: NodeJS.ProcessEnv = process.env) {
  const required = new Set([...requiredEnvVarsForModel(deliveryModel), ...requiredEnvVarsForModel(judgeModel)]);
  return [...required].filter((name) => !isConfiguredEnvValue(env[name]));
}

export function assertDeliveryModelEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const missing = missingEnvVarsForDeliveryModels(env);
  if (!missing.length) return;

  throw new Error(
    [
      `Delivery workflow requires ${missing.join(', ')} for model ${deliveryModel}.`,
      'Set it in your shell or in .env, then rerun npm run delivery:run.',
    ].join(' '),
  );
}
