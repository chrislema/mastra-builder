import { hasProfile } from './profiles';
import type { ProjectProfile } from './schemas';

type JsonObject = Record<string, unknown>;

const mirroredBindingKeys = [
  'vars',
  'ai',
  'assets',
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'services',
  'workflows',
];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function environmentMirror(config: JsonObject) {
  const mirrored: JsonObject = {};
  for (const key of mirroredBindingKeys) {
    if (config[key] !== undefined) mirrored[key] = cloneJson(config[key]);
  }

  return {
    staging: cloneJson(mirrored),
    production: cloneJson(mirrored),
  };
}

export function bindingMapForProfiles(profiles: ProjectProfile[], externalServiceBindings: string[] = []) {
  const bindings: Record<string, string> = { ASSETS: 'static assets binding for ./public' };
  if (hasProfile(profiles, 'worker-workers-ai')) bindings.AI = 'Workers AI binding';
  if (hasProfile(profiles, 'worker-d1')) bindings.DB = 'D1 database binding';
  if (hasProfile(profiles, 'worker-kv')) bindings.KV = 'KV namespace binding';
  if (hasProfile(profiles, 'worker-r2')) bindings.ARTIFACTS = 'R2 bucket binding';
  if (hasProfile(profiles, 'worker-workflows')) bindings.PROCESSING_WORKFLOW = 'Workers Workflow binding';
  for (const binding of externalServiceBindings) {
    bindings[binding] = 'external Worker service binding';
  }
  return bindings;
}

export function wranglerConfigObject({
  projectName,
  main,
  compatibilityDate,
  profiles,
  externalServiceBindings = [],
}: {
  projectName: string;
  main: string;
  compatibilityDate: string;
  profiles: ProjectProfile[];
  externalServiceBindings?: string[];
}) {
  const config: JsonObject = {
    $schema: './node_modules/wrangler/config-schema.json',
    name: projectName,
    main,
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: './public', binding: 'ASSETS' },
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: { APP_ENV: 'development' },
  };

  if (hasProfile(profiles, 'worker-workers-ai')) config.ai = { binding: 'AI', remote: true };
  if (hasProfile(profiles, 'worker-d1')) {
    config.d1_databases = [
      {
        binding: 'DB',
        database_name: projectName,
        database_id: 'local-placeholder',
      },
    ];
  }
  if (hasProfile(profiles, 'worker-kv')) {
    config.kv_namespaces = [{ binding: 'KV', id: 'local-placeholder' }];
  }
  if (hasProfile(profiles, 'worker-r2')) {
    config.r2_buckets = [{ binding: 'ARTIFACTS', bucket_name: `${projectName}-artifacts` }];
  }
  if (hasProfile(profiles, 'worker-workflows')) {
    config.workflows = [
      {
        binding: 'PROCESSING_WORKFLOW',
        name: `${projectName}-processing`,
        class_name: 'ProcessingWorkflow',
      },
    ];
  }
  if (externalServiceBindings.length > 0) {
    config.services = externalServiceBindings.map((binding) => ({
      binding,
      service: `${projectName}-${binding.toLowerCase().replaceAll('_', '-')}`,
    }));
  }

  return {
    ...config,
    env: environmentMirror(config),
  };
}

export function renderWranglerConfig(input: {
  projectName: string;
  main: string;
  compatibilityDate: string;
  profiles: ProjectProfile[];
  externalServiceBindings?: string[];
}) {
  return `${JSON.stringify(wranglerConfigObject(input), null, 2)}\n`;
}
