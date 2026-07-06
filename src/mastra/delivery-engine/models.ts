const defaultDeliveryModel = 'openai/gpt-5.5';

const configuredModel = (env: NodeJS.ProcessEnv, name: string, fallback: string) => env[name]?.trim() || fallback;

export const configuredDeliveryModel = (env: NodeJS.ProcessEnv = process.env) =>
  configuredModel(env, 'DELIVERY_MODEL', defaultDeliveryModel);

export const configuredJudgeModel = (env: NodeJS.ProcessEnv = process.env) =>
  configuredModel(env, 'DELIVERY_JUDGE_MODEL', configuredDeliveryModel(env));

export const deliveryModel = configuredDeliveryModel();
export const judgeModel = configuredJudgeModel();
export const deliveryStructuredOutputOptions = {
  jsonPromptInjection: true,
  errorStrategy: 'warn',
} as const;

export const deliveryToolStructuredOutputOptions = {
  ...deliveryStructuredOutputOptions,
  model: deliveryModel,
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
  const required = new Set([
    ...requiredEnvVarsForModel(configuredDeliveryModel(env)),
    ...requiredEnvVarsForModel(configuredJudgeModel(env)),
  ]);
  return [...required].filter((name) => !isConfiguredEnvValue(env[name]));
}

export function assertDeliveryModelEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const missing = missingEnvVarsForDeliveryModels(env);
  if (!missing.length) return;

  throw new Error(
    [
      `Delivery workflow requires ${missing.join(', ')} for the configured delivery models.`,
      `Delivery model: ${configuredDeliveryModel(env)}. Judge model: ${configuredJudgeModel(env)}.`,
      'Set it in your shell or in .env, then rerun npm run delivery:run.',
    ].join(' '),
  );
}
