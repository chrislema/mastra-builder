import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeDeliveryPathReference } from './checks';

export interface AcceptanceContractTask {
  id: string;
  owned_surfaces: string[];
}

export interface AcceptanceContractContext {
  criterion: string;
  performed: string[];
  repoPath?: string;
  task?: AcceptanceContractTask;
}

export interface AcceptanceContractEvidence {
  passed: boolean;
  evidence: string[];
  gaps: string[];
}

export interface AcceptanceContractDefinition {
  id: string;
  title: string;
  surfaces: readonly string[];
  matches: (context: AcceptanceContractContext) => boolean;
  evaluate: (context: AcceptanceContractContext) => AcceptanceContractEvidence | undefined;
}

type WorkerBindingKind =
  | 'ai'
  | 'assets'
  | 'd1'
  | 'durable_object'
  | 'hyperdrive'
  | 'kv'
  | 'queue'
  | 'r2'
  | 'service'
  | 'vectorize'
  | 'workflow';

interface WorkerBindingDeclaration {
  name: string;
  kind: WorkerBindingKind;
}

const knownRootPathSurfaces = new Set([
  '.gitignore',
  'package.json',
  'package-lock.json',
  'README.md',
  'tsconfig.json',
  'wrangler.json',
  'wrangler.jsonc',
  'wrangler.toml',
]);

const moduleSourceExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'] as const;
const workerDeploymentEnvironments = ['staging', 'production'] as const;

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function looksLikeRepoPathReference(surface: string) {
  const path = normalizeDeliveryPathReference(surface);
  if (!path || /\s/.test(path)) return false;
  if (knownRootPathSurfaces.has(path)) return true;
  if (path.includes('/')) return true;
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(path);
}

function concreteOwnedSurfacePath(surface: string) {
  const trimmed = normalizeDeliveryPathReference(surface);
  if (!trimmed || trimmed.includes('*') || /^unknown\b/i.test(trimmed)) return undefined;
  if (!looksLikeRepoPathReference(trimmed)) return undefined;
  return trimmed;
}

function firstExistingRepoPath(repoPath: string, candidates: string[]) {
  return candidates.find((candidate) => existsSync(join(resolve(repoPath), candidate)));
}

function taskBoundarySurfaces(repoPath: string, task: AcceptanceContractTask) {
  const surfaces = new Set(task.owned_surfaces);
  for (const surface of task.owned_surfaces) {
    const path = concreteOwnedSurfacePath(surface);
    if (!path || !path.includes('/')) continue;
    const parts = path.split('/');
    parts.pop();
    const directory = parts.join('/');
    if (!directory) continue;

    const barrel = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `${directory}/index.${extension}`),
    );
    if (barrel) surfaces.add(barrel);

    const workerEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/index.${extension}`),
    );
    if (directory === 'src/routes' && workerEntry) surfaces.add(workerEntry);
  }

  return [...surfaces];
}

function stripJsoncComments(text: string) {
  let output = '';
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length) {
        if (text[index] === '\n') output += '\n';
        if (text[index] === '*' && text[index + 1] === '/') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    output += char;
  }

  return output;
}

function parseJsoncObject(text: string) {
  const withoutComments = stripJsoncComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(withoutTrailingCommas) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function packageRecord(repoPath: string) {
  const packagePath = join(resolve(repoPath), 'package.json');
  if (!existsSync(packagePath)) return undefined;
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function assetDirectoryIsPublic(value: unknown) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '');
  return normalized === 'public';
}

function pushJsonBinding(
  declarations: WorkerBindingDeclaration[],
  value: unknown,
  kind: WorkerBindingKind,
  key: 'binding' | 'name' = 'binding',
) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = recordValue(item);
    const name = record?.[key];
    if (typeof name === 'string' && name.trim()) declarations.push({ name, kind });
  }
}

function workerJsonConfigBindingDeclarations(config: Record<string, unknown>) {
  const declarations: WorkerBindingDeclaration[] = [];

  const ai = recordValue(config.ai);
  if (typeof ai?.binding === 'string' && ai.binding.trim()) declarations.push({ name: ai.binding, kind: 'ai' });

  const assets = recordValue(config.assets);
  if (typeof assets?.binding === 'string' && assets.binding.trim()) declarations.push({ name: assets.binding, kind: 'assets' });

  pushJsonBinding(declarations, config.d1_databases, 'd1');
  pushJsonBinding(declarations, config.durable_objects && recordValue(config.durable_objects)?.bindings, 'durable_object', 'name');
  pushJsonBinding(declarations, config.hyperdrive, 'hyperdrive');
  pushJsonBinding(declarations, config.kv_namespaces, 'kv');
  pushJsonBinding(declarations, config.r2_buckets, 'r2');
  pushJsonBinding(declarations, config.services, 'service');
  pushJsonBinding(declarations, config.vectorize, 'vectorize');
  pushJsonBinding(declarations, config.workflows, 'workflow');

  const queues = recordValue(config.queues);
  pushJsonBinding(declarations, queues?.producers, 'queue');

  return declarations;
}

function workerJsonConfigVarNames(config: Record<string, unknown>) {
  const vars = recordValue(config.vars);
  return vars ? Object.keys(vars).filter(Boolean) : [];
}

function workerJsonEnvironmentRecord(config: Record<string, unknown>, environmentName: string) {
  return recordValue(recordValue(config.env)?.[environmentName]);
}

function wranglerJsonConfig(repoPath: string) {
  const configPath = join(resolve(repoPath), 'wrangler.jsonc');
  if (!existsSync(configPath)) return undefined;
  return parseJsoncObject(readFileSync(configPath, 'utf8'));
}

function taskOwns(context: AcceptanceContractContext, surface: string) {
  return Boolean(context.repoPath && context.task && taskBoundarySurfaces(context.repoPath, context.task).includes(surface));
}

function ensureTaskRepo(context: AcceptanceContractContext) {
  return context.repoPath && context.task ? { repoPath: context.repoPath, task: context.task } : undefined;
}

function packageScriptContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'package.json')) return undefined;

  const packageJson = packageRecord(target.repoPath);
  const scripts = recordValue(packageJson?.scripts);

  if (/\b(?:package-level\s+test\s+script|scripts\.test|npm\s+test)\b/i.test(context.criterion) && /\bVitest\b/i.test(context.criterion)) {
    const actualCommand = scripts?.test;
    if (typeof actualCommand !== 'string' || !/\bvitest\b/i.test(actualCommand)) {
      return {
        passed: false,
        evidence: [],
        gaps: [
          `package.json scripts.test must run Vitest${
            typeof actualCommand === 'string' ? `, but found "${actualCommand}".` : ', but it is missing.'
          }`,
        ],
      };
    }

    return {
      passed: true,
      evidence: [`structured package.json evidence verified scripts.test runs Vitest via "${actualCommand}"`],
      gaps: [],
    };
  }

  const scriptMatch = context.criterion.match(/\bscripts\.([A-Za-z0-9:_-]+)\b[\s\S]{0,80}\bexactly\s+as\s+["']([^"']+)["']/i);
  if (!scriptMatch) return undefined;

  const [, scriptName, expectedCommand] = scriptMatch;
  const actualCommand = scripts?.[scriptName];

  if (actualCommand !== expectedCommand) {
    return {
      passed: false,
      evidence: [],
      gaps: [
        `package.json scripts.${scriptName} must be exactly "${expectedCommand}"${
          typeof actualCommand === 'string' ? `, but found "${actualCommand}".` : ', but it is missing.'
        }`,
      ],
    };
  }

  return {
    passed: true,
    evidence: [`structured package.json evidence verified scripts.${scriptName} exactly "${expectedCommand}"`],
    gaps: [],
  };
}

function workerValidationWithoutFrontendBuildContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'package.json')) return undefined;

  const surfaces = taskBoundarySurfaces(target.repoPath, target.task);
  const packageJson = packageRecord(target.repoPath);
  const scripts = recordValue(packageJson?.scripts);
  const gaps: string[] = [];

  const scriptEntries = Object.entries(scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  const hasLocalWranglerValidation = scriptEntries.some(
    ([name, command]) => /^(?:dev|local:validate)$/.test(name) && /\bwrangler\s+dev\b/.test(command) && /--env\s+staging\b/.test(command),
  );
  const hasDryRunWranglerValidation = scriptEntries.some(
    ([name, command]) =>
      /^(?:dry-run|production:dry-run|validate)$/.test(name) &&
      /\bwrangler\s+deploy\b/.test(command) &&
      /--dry-run\b/.test(command) &&
      /--env\s+production\b/.test(command),
  );

  if (!hasLocalWranglerValidation && !hasDryRunWranglerValidation) {
    gaps.push('package.json must expose Wrangler local or production dry-run validation through scripts.');
  }

  const validationCommands = scriptEntries
    .filter(([name]) => /^(?:dev|local:validate|dry-run|production:dry-run|validate)$/.test(name))
    .map(([, command]) => command)
    .join('\n');
  if (/\b(?:npm|pnpm|yarn)\s+run\s+build\b|\b(?:vite|webpack|parcel|next|react-scripts)\s+build\b/i.test(validationCommands)) {
    gaps.push('Wrangler validation scripts must not require a frontend build step.');
  }

  const directFrontendBuildScript = scripts?.build;
  if (typeof directFrontendBuildScript === 'string' && /\b(?:vite|webpack|parcel|next|react-scripts)\b/i.test(directFrontendBuildScript)) {
    gaps.push('package.json must not define a frontend build script for the vanilla Worker scaffold.');
  }

  const wranglerPath = join(resolve(target.repoPath), 'wrangler.jsonc');
  if (surfaces.includes('wrangler.jsonc')) {
    if (!existsSync(wranglerPath)) {
      gaps.push('wrangler.jsonc must exist for config-driven Wrangler validation.');
    } else {
      const config = parseJsoncObject(readFileSync(wranglerPath, 'utf8'));
      if (!config) {
        gaps.push('wrangler.jsonc must be valid JSONC for config-driven Wrangler validation.');
      } else if (typeof config.main !== 'string' || (config.main !== 'src/index.ts' && !config.main.startsWith('src/index.'))) {
        gaps.push('wrangler.jsonc main must point at the Worker entrypoint rather than a frontend build output.');
      }
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured package.json/wrangler evidence verified Wrangler validation scripts do not require a frontend build step'],
    gaps: [],
  };
}

function workerConfigEnvironmentContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const config = wranglerJsonConfig(target.repoPath);
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so environment bindings could not be verified.'],
    };
  }

  const requiredBindingCandidates: Array<{ name: string; kind: WorkerBindingKind }> = [
    { name: 'BOOKMARKS', kind: 'service' },
    { name: 'DB', kind: 'd1' },
    { name: 'ARTIFACTS', kind: 'r2' },
    { name: 'WEEKLY_WORKFLOW', kind: 'workflow' },
    { name: 'AI', kind: 'ai' },
    { name: 'ASSETS', kind: 'assets' },
  ];
  const requiredBindings = requiredBindingCandidates.filter((binding) =>
    new RegExp(`\\b${binding.name}\\b`, 'i').test(context.criterion),
  );

  const gaps: string[] = [];
  const envVarSets: string[][] = [];
  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (!environment) {
      gaps.push(`wrangler.jsonc env.${environmentName} is missing.`);
      continue;
    }

    const bindings = new Set(
      workerJsonConfigBindingDeclarations(environment).map((binding) => `${binding.kind}:${binding.name}`),
    );
    for (const binding of requiredBindings) {
      if (!bindings.has(`${binding.kind}:${binding.name}`)) {
        gaps.push(`wrangler.jsonc env.${environmentName} is missing ${binding.name} as a ${binding.kind} binding.`);
      }
    }

    if (/assets\.directory\s+["']?\.\/public/i.test(context.criterion)) {
      const assets = recordValue(environment.assets);
      if (!assetDirectoryIsPublic(assets?.directory)) {
        gaps.push(`wrangler.jsonc env.${environmentName}.assets.directory must be "./public".`);
      }
    }

    if (/assets\.binding\s+["']?ASSETS/i.test(context.criterion)) {
      const assets = recordValue(environment.assets);
      if (assets?.binding !== 'ASSETS') {
        gaps.push(`wrangler.jsonc env.${environmentName}.assets.binding must be "ASSETS".`);
      }
    }

    const vars = workerJsonConfigVarNames(environment).sort();
    envVarSets.push(vars);
    if (/\bvars\b|\bnon-secret vars\b/i.test(context.criterion) && vars.length === 0) {
      gaps.push(`wrangler.jsonc env.${environmentName}.vars must declare required non-secret vars.`);
    }
  }

  if (/\bmirrors?\b/i.test(context.criterion) && envVarSets.length === workerDeploymentEnvironments.length) {
    const [first, ...rest] = envVarSets.map((vars) => vars.join('\n'));
    for (const vars of rest) {
      if (vars !== first) {
        gaps.push('wrangler.jsonc env.staging.vars and env.production.vars must mirror the same non-secret var names.');
        break;
      }
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [
      `structured wrangler.jsonc evidence verified ${workerDeploymentEnvironments.join(
        '/',
      )} environments with ${requiredBindings.map((binding) => `${binding.kind}:${binding.name}`).join(', ')}`,
    ],
    gaps: [],
  };
}

function workerConfigStaticAssetsContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const config = wranglerJsonConfig(target.repoPath);
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so Workers Static Assets could not be verified.'],
    };
  }

  const gaps: string[] = [];
  const verifyAssets = (scopeName: string, scope: Record<string, unknown> | undefined) => {
    const assets = recordValue(scope?.assets);
    if (!assetDirectoryIsPublic(assets?.directory)) gaps.push(`wrangler.jsonc ${scopeName}.assets.directory must be "./public".`);
    if (assets?.binding !== 'ASSETS') gaps.push(`wrangler.jsonc ${scopeName}.assets.binding must be "ASSETS".`);
  };

  verifyAssets('top-level', config);
  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (environment) verifyAssets(`env.${environmentName}`, environment);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified Workers Static Assets directory "./public" and binding "ASSETS"'],
    gaps: [],
  };
}

function workerConfigCompatibilityFlagsContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const config = wranglerJsonConfig(target.repoPath);
  if (!config) {
    return { passed: false, evidence: [], gaps: ['wrangler.jsonc is not valid JSONC, so compatibility flags could not be verified.'] };
  }

  const scopes: Array<[string, Record<string, unknown> | undefined]> = [['top-level', config]];
  if (/\benv\.staging\b|\benv\.production\b|\bmirrors?\b/i.test(context.criterion)) {
    scopes.push(['env.staging', workerJsonEnvironmentRecord(config, 'staging')]);
    scopes.push(['env.production', workerJsonEnvironmentRecord(config, 'production')]);
  }

  const gaps = scopes.flatMap(([label, scope]) => {
    const flags = stringArrayValue(scope?.compatibility_flags);
    return flags.includes('nodejs_compat') ? [] : [`wrangler.jsonc ${label}.compatibility_flags must contain nodejs_compat.`];
  });

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified compatibility_flags contains nodejs_compat'],
    gaps: [],
  };
}

function workerConfigNoPagesContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const config = wranglerJsonConfig(target.repoPath);
  if (!config) {
    return { passed: false, evidence: [], gaps: ['wrangler.jsonc is not valid JSONC, so Pages absence could not be verified.'] };
  }

  const pagesKeys = ['pages', 'pages_build_output_dir', 'pages_build', 'functions', 'pages_functions'];
  const present = pagesKeys.filter((key) => Object.prototype.hasOwnProperty.call(config, key));
  if (present.length) {
    return { passed: false, evidence: [], gaps: [`wrangler.jsonc contains Pages-specific keys: ${present.join(', ')}.`] };
  }

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified no Cloudflare Pages or Pages Functions config'],
    gaps: [],
  };
}

function configScopeHasAdminTokenVar(scope: Record<string, unknown> | undefined) {
  const vars = recordValue(scope?.vars);
  return Boolean(vars && Object.prototype.hasOwnProperty.call(vars, 'ADMIN_TOKEN'));
}

function workerConfigAdminTokenSecretContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const configPath = join(resolve(target.repoPath), 'wrangler.jsonc');
  if (!existsSync(configPath)) return undefined;

  const source = readFileSync(configPath, 'utf8');
  const config = parseJsoncObject(source);
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so ADMIN_TOKEN secret readiness could not be verified.'],
    };
  }

  const gaps: string[] = [];
  if (configScopeHasAdminTokenVar(config)) gaps.push('wrangler.jsonc top-level vars must not commit ADMIN_TOKEN.');

  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (configScopeHasAdminTokenVar(environment)) gaps.push(`wrangler.jsonc env.${environmentName}.vars must not commit ADMIN_TOKEN.`);
  }

  if (!/(wrangler\s+secret\s+put\s+ADMIN_TOKEN|ADMIN_TOKEN[\s\S]{0,120}secret|secret[\s\S]{0,120}ADMIN_TOKEN)/i.test(source)) {
    gaps.push('wrangler.jsonc should document ADMIN_TOKEN as a Cloudflare secret, not a committed var.');
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified ADMIN_TOKEN is documented as a secret and not committed in vars'],
    gaps: [],
  };
}

function gitignoreRuntimeArtifactContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, '.gitignore')) return undefined;

  const gitignorePath = join(resolve(target.repoPath), '.gitignore');
  if (!existsSync(gitignorePath)) return undefined;

  const source = readFileSync(gitignorePath, 'utf8');
  const gaps: string[] = [];
  const requiredGroups: Array<{ label: string; patterns: RegExp[] }> = [
    { label: 'dependencies', patterns: [/^node_modules\/?$/m] },
    { label: 'Wrangler local state', patterns: [/^\.wrangler\/?$/m] },
    { label: 'env files', patterns: [/^\.env\*?$/m, /^\.dev\.vars\*?$/m] },
  ];
  if (/\bgenerated secrets?\b/i.test(context.criterion)) {
    requiredGroups.push({
      label: 'generated secrets',
      patterns: [/^(?:\.secrets\*?|\.secrets\/?|secrets\/?|generated-secrets\/?|\*\.secrets?|\*\.pem|\*\.key)$/m],
    });
  }
  if (/\bcache\b/i.test(context.criterion)) requiredGroups.push({ label: 'cache artifacts', patterns: [/^\.cache\/?$/m, /^cache\/?$/m] });
  if (/\bbuild\b|\bruntime artifacts?\b/i.test(context.criterion)) {
    requiredGroups.push({ label: 'build/runtime artifacts', patterns: [/^dist\/?$/m, /^build\/?$/m] });
  }

  for (const group of requiredGroups) {
    if (!group.patterns.every((pattern) => pattern.test(source))) gaps.push(`.gitignore must exclude ${group.label}.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured .gitignore evidence verified dependencies, Wrangler state, env files, generated secrets, and runtime artifacts as required'],
    gaps: [],
  };
}

function tsconfigWorkerScaffoldGaps(repoPath: string) {
  const tsconfigPath = join(resolve(repoPath), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return ['tsconfig.json: missing; TypeScript Worker scaffolds need a Worker-runtime TypeScript config for deterministic typecheck.'];
  }

  const config = parseJsoncObject(readFileSync(tsconfigPath, 'utf8'));
  if (!config) return ['tsconfig.json: file is not valid JSONC.'];

  const compilerOptions = recordValue(config.compilerOptions);
  if (!compilerOptions) return ['tsconfig.json: compilerOptions is missing.'];

  const gaps: string[] = [];
  const target = typeof compilerOptions.target === 'string' ? compilerOptions.target.toLowerCase() : '';
  if (!/^es(?:202[2-9]|next)$/.test(target)) gaps.push('tsconfig.json: compilerOptions.target should be ES2022 or newer for Cloudflare Workers.');

  const module = typeof compilerOptions.module === 'string' ? compilerOptions.module.toLowerCase() : '';
  if (module !== 'esnext') gaps.push('tsconfig.json: compilerOptions.module should be ESNext for Worker module syntax.');

  const moduleResolution =
    typeof compilerOptions.moduleResolution === 'string' ? compilerOptions.moduleResolution.toLowerCase() : '';
  if (moduleResolution !== 'bundler') gaps.push('tsconfig.json: compilerOptions.moduleResolution should be Bundler for Wrangler/Worker imports.');

  const libs = stringArrayValue(compilerOptions.lib).map((item) => item.toLowerCase());
  if (!libs.some((item) => /^es(?:202[2-9]|next)$/.test(item))) gaps.push('tsconfig.json: compilerOptions.lib should include ES2022 or newer.');
  if (!libs.includes('webworker')) gaps.push('tsconfig.json: compilerOptions.lib should include WebWorker for Cloudflare Worker globals.');

  const includes = stringArrayValue(config.include).map((item) => item.toLowerCase());
  if (!includes.includes('./worker-configuration.d.ts') && !includes.includes('worker-configuration.d.ts')) {
    gaps.push('tsconfig.json: include should contain worker-configuration.d.ts generated by wrangler types.');
  }

  const types = stringArrayValue(compilerOptions.types).map((item) => item.toLowerCase());
  if (!types.includes('node')) gaps.push('tsconfig.json: compilerOptions.types should include node when nodejs_compat is enabled.');
  if (compilerOptions.strict !== true) gaps.push('tsconfig.json: compilerOptions.strict should be true.');

  return gaps;
}

function tsconfigWorkerContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'tsconfig.json')) return undefined;

  const tsconfigPath = join(resolve(target.repoPath), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return { passed: false, evidence: [], gaps: ['tsconfig.json is missing.'] };

  const gaps = tsconfigWorkerScaffoldGaps(target.repoPath);
  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured tsconfig.json evidence verified Worker TypeScript scaffold settings and generated Wrangler type include'],
    gaps: [],
  };
}

function noTsconfigContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target) return undefined;
  if (existsSync(join(resolve(target.repoPath), 'tsconfig.json'))) {
    return { passed: false, evidence: [], gaps: ['tsconfig.json exists even though the vanilla JavaScript scaffold forbids it.'] };
  }

  return {
    passed: true,
    evidence: ['structured repo evidence verified tsconfig.json is absent for the vanilla JavaScript Worker scaffold'],
    gaps: [],
  };
}

function indexSurface(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target) return undefined;
  return taskBoundarySurfaces(target.repoPath, target.task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
}

function honoWorkerEntrypointContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  const surface = indexSurface(context);
  if (!target || surface !== 'src/index.ts') return undefined;

  const indexPath = join(resolve(target.repoPath), 'src/index.ts');
  if (!existsSync(indexPath)) return { passed: false, evidence: [], gaps: ['src/index.ts is missing.'] };

  const source = readFileSync(indexPath, 'utf8');
  const gaps: string[] = [];
  if (!/import\s*\{?\s*Hono\s*\}?\s*from\s*['"]hono['"]/i.test(source)) gaps.push('src/index.ts must import Hono from hono.');
  if (!/\bnew\s+Hono\b/.test(source)) gaps.push('src/index.ts must create a Hono app.');
  if (!/export\s+default\s+[A-Za-z_$][\w$]*\s*;?/m.test(source) && !/export\s+default\s+\{[\s\S]*\bfetch\b/m.test(source)) {
    gaps.push('src/index.ts must export the Hono app or a Worker object as the default Worker module entrypoint.');
  }
  if (/\/api\/health\b|\bhealth\b/i.test(context.criterion)) {
    if (!/\bapp\.(?:get|all)\(\s*['"]\/api\/health['"]/i.test(source)) gaps.push('src/index.ts must register GET /api/health on the Hono app.');
    if (/\bok\b/i.test(context.criterion) && !/\bok\s*:\s*true\b/i.test(source)) gaps.push('src/index.ts health response must include ok: true.');
    if (/\bBenchmark\b/i.test(context.criterion) && !/\bbenchmark\b/i.test(source)) {
      gaps.push('src/index.ts health response must identify the Benchmark service.');
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured src/index.ts evidence verified a Hono Worker module entrypoint export and health route'],
    gaps: [],
  };
}

function workerMinimalEntrypointContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  const surface = indexSurface(context);
  if (!target || !surface) return undefined;

  const fullPath = join(resolve(target.repoPath), surface);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  const exportsWorker =
    /export\s+default\s+[A-Za-z_$][\w$]*\s*;?/m.test(source) ||
    /export\s+default\s+\{[\s\S]*\bfetch\s*(?:\(|:)[\s\S]*\}/m.test(source) ||
    /export\s+(?:async\s+)?function\s+fetch\s*\(/m.test(source);
  if (!exportsWorker) gaps.push(`${surface} must export a Worker module entrypoint.`);
  if (!/(?:\bnew\s+Hono\b|\bfetch\s*\()/.test(source)) gaps.push(`${surface} must define a Worker fetch path or Hono app.`);
  if (!/(?:\.(?:text|json|html)\s*\(|new\s+Response\s*\(|Response\.json\s*\()/.test(source)) {
    gaps.push(`${surface} must return a basic Response before later API wiring.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured ${surface} evidence verified a minimal Worker entrypoint with a basic response`],
    gaps: [],
  };
}

export const workerScaffoldAcceptanceContracts: AcceptanceContractDefinition[] = [
  {
    id: 'package.scripts',
    title: 'Package scripts',
    surfaces: ['package.json'],
    matches: ({ criterion }) => /\bpackage\.json\b/i.test(criterion),
    evaluate: packageScriptContractEvidence,
  },
  {
    id: 'worker.validation.noFrontendBuild',
    title: 'Wrangler validation without frontend build',
    surfaces: ['package.json', 'wrangler.jsonc'],
    matches: ({ criterion }) =>
      /\bWrangler\b/i.test(criterion) && /\b(?:local|dry-run)\b/i.test(criterion) && /\bfrontend build step\b/i.test(criterion),
    evaluate: workerValidationWithoutFrontendBuildContractEvidence,
  },
  {
    id: 'worker.config.adminTokenSecret',
    title: 'ADMIN_TOKEN secret readiness',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => /\bwrangler\.jsonc\b/i.test(criterion) && /\bADMIN_TOKEN\b/.test(criterion) && /\b(secret|commit|embed|var)\b/i.test(criterion),
    evaluate: workerConfigAdminTokenSecretContractEvidence,
  },
  {
    id: 'worker.config.environments',
    title: 'Wrangler staging and production environments',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => {
      const mentionsDeploymentEnvironments =
        (/\benv\.staging\b/i.test(criterion) && /\benv\.production\b/i.test(criterion)) ||
        (/\bstaging\b/i.test(criterion) && /\bproduction\b/i.test(criterion));
      return /\bwrangler\.jsonc\b/i.test(criterion) && mentionsDeploymentEnvironments;
    },
    evaluate: workerConfigEnvironmentContractEvidence,
  },
  {
    id: 'worker.config.staticAssets',
    title: 'Workers Static Assets config',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => /\bwrangler\.jsonc\b/i.test(criterion) && /\bWorkers Static Assets\b|\bassets\.directory\b|\bASSETS\b/i.test(criterion),
    evaluate: workerConfigStaticAssetsContractEvidence,
  },
  {
    id: 'worker.config.compatibilityFlags',
    title: 'Worker compatibility flags',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => /\bwrangler\.jsonc\b/i.test(criterion) && /\bcompatibility_flags\b/i.test(criterion) && /\bnodejs_compat\b/i.test(criterion),
    evaluate: workerConfigCompatibilityFlagsContractEvidence,
  },
  {
    id: 'worker.config.noPages',
    title: 'No Pages config',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => /\bwrangler\.jsonc\b/i.test(criterion) && /\bdoes not configure\b[\s\S]{0,80}\b(?:Cloudflare Pages|Pages Functions)\b/i.test(criterion),
    evaluate: workerConfigNoPagesContractEvidence,
  },
  {
    id: 'repo.gitignore.runtimeArtifacts',
    title: 'Runtime artifact gitignore coverage',
    surfaces: ['.gitignore'],
    matches: ({ criterion }) => /\.gitignore\b/i.test(criterion) && /\b(dependencies|wrangler|env files?|build|runtime artifacts?)\b/i.test(criterion),
    evaluate: gitignoreRuntimeArtifactContractEvidence,
  },
  {
    id: 'worker.tsconfig',
    title: 'Worker TypeScript config',
    surfaces: ['tsconfig.json'],
    matches: ({ criterion }) =>
      /\btsconfig\.json\b/i.test(criterion) && !/\bno\s+tsconfig\.json\b|\btsconfig\.json\s+is\s+not\s+created\b/i.test(criterion),
    evaluate: tsconfigWorkerContractEvidence,
  },
  {
    id: 'worker.noTsconfig',
    title: 'No TypeScript config',
    surfaces: ['tsconfig.json'],
    matches: ({ criterion }) => /\bno\s+tsconfig\.json\b|\btsconfig\.json\s+is\s+not\s+created\b/i.test(criterion),
    evaluate: noTsconfigContractEvidence,
  },
  {
    id: 'worker.entrypoint.honoHealth',
    title: 'Hono Worker health route',
    surfaces: ['src/index.ts'],
    matches: ({ criterion }) => {
      const criterionMentionsHealthRoute = /\/api\/health\b|\bhealth\b/i.test(criterion);
      const criterionMentionsHono = /\bHono\b|\bWorker module through Hono\b|\bthrough Hono\b/i.test(criterion);
      return (
        /\bsrc\/index\.ts\b/i.test(criterion) &&
        (criterionMentionsHealthRoute || criterionMentionsHono) &&
        /\bWorker-compatible module\b|\bWorker module entrypoint\b|\bWorker\b[\s\S]{0,80}\bentrypoint\b|\bloaded by Wrangler\b|\bWorker module through Hono\b|\bthrough Hono\b|\/api\/health\b/i.test(
          criterion,
        )
      );
    },
    evaluate: honoWorkerEntrypointContractEvidence,
  },
  {
    id: 'worker.entrypoint.minimal',
    title: 'Minimal Worker entrypoint',
    surfaces: ['src/index.ts', 'src/index.js'],
    matches: ({ criterion }) =>
      /\bsrc\/index\.(js|ts)\b/i.test(criterion) && /\bminimal Worker module entrypoint\b|\bloaded by Wrangler\b|\bbasic response\b/i.test(criterion),
    evaluate: workerMinimalEntrypointContractEvidence,
  },
];

export function evaluateWorkerScaffoldAcceptanceContract(context: AcceptanceContractContext) {
  for (const contract of workerScaffoldAcceptanceContracts) {
    if (!contract.matches(context)) continue;
    const result = contract.evaluate(context);
    if (result) return result;
  }

  return undefined;
}
