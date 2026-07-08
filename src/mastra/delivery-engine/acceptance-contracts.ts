import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isBehaviorLikeAcceptanceCriterion } from './acceptance-evidence-policy';
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

export interface AcceptanceContractRecord {
  id: string;
  criterion: string;
  status: 'verified' | 'unverified';
  evidence: string[];
  gaps: string[];
}

export const workerScaffoldAcceptanceCriteria = {
  packageDev: 'package.json exists and defines scripts.dev exactly as "wrangler dev --env staging".',
  packageDeploy: 'package.json exists and defines scripts.deploy exactly as "wrangler deploy --env production".',
  packageGenerateTypes: 'package.json exists and defines scripts.generate-types exactly as "wrangler types".',
  packageTypecheckTs:
    'package.json exists and defines scripts.typecheck exactly as "npm run generate-types && tsc --noEmit".',
  packageTypecheckJs:
    'package.json exists and defines scripts.typecheck exactly as "node scripts/check-js.js".',
  noFrontendBuild:
    'package.json and wrangler.jsonc provide the scripts and configuration needed for later Wrangler local and production dry-run validation without requiring a frontend build step.',
  firstSliceRunnable:
    'The first build slice is structurally runnable by Wrangler without requiring database migrations, Pages, React/Vite, or public UI files.',
  wranglerEnvironments:
    'wrangler.jsonc defines env.staging and env.production with mirrored non-secret vars and required Worker bindings.',
  wranglerAiBinding: 'wrangler.jsonc configures Workers AI with binding AI.',
  wranglerCompatibilityFlags: 'wrangler.jsonc includes compatibility_flags containing nodejs_compat.',
  wranglerNoPages: 'wrangler.jsonc does not configure Cloudflare Pages or Pages Functions.',
  gitignoreRuntimeArtifacts:
    '.gitignore excludes dependencies, Wrangler local state, .delivery artifacts, env files, generated secrets, cache/build/runtime artifacts, and startup profiles (*.cpuprofile).',
  tsconfigWorker:
    'tsconfig.json exists with Cloudflare Worker TypeScript scaffold settings and includes worker-configuration.d.ts as a Wrangler-generated verification output, not a hand-written owned source surface.',
  noTsconfig: 'No tsconfig.json is created.',
} as const;

export function canonicalRootWorkerScaffoldAcceptanceCriteria({
  entrypointSurface,
  ownsGitignore,
  ownsPackage,
  ownsWorkerConfig,
  typeScript,
}: {
  entrypointSurface?: string;
  ownsGitignore: boolean;
  ownsPackage: boolean;
  ownsWorkerConfig: boolean;
  typeScript: boolean;
}) {
  const criteria: string[] = [];

  if (ownsGitignore) criteria.push(workerScaffoldAcceptanceCriteria.gitignoreRuntimeArtifacts);

  if (ownsPackage) {
    criteria.push(
      workerScaffoldAcceptanceCriteria.packageDev,
      workerScaffoldAcceptanceCriteria.packageDeploy,
      workerScaffoldAcceptanceCriteria.noFrontendBuild,
    );
    criteria.push(
      typeScript
        ? workerScaffoldAcceptanceCriteria.packageGenerateTypes
        : workerScaffoldAcceptanceCriteria.packageTypecheckJs,
    );
    if (typeScript) criteria.push(workerScaffoldAcceptanceCriteria.packageTypecheckTs);
  }

  if (ownsWorkerConfig) {
    criteria.push(
      workerScaffoldAcceptanceCriteria.firstSliceRunnable,
      workerScaffoldAcceptanceCriteria.wranglerEnvironments,
      workerScaffoldAcceptanceCriteria.wranglerAiBinding,
      workerScaffoldAcceptanceCriteria.wranglerCompatibilityFlags,
      workerScaffoldAcceptanceCriteria.wranglerNoPages,
    );
  }

  criteria.push(typeScript ? workerScaffoldAcceptanceCriteria.tsconfigWorker : workerScaffoldAcceptanceCriteria.noTsconfig);

  if (entrypointSurface && /^src\/index\.(?:js|ts)$/.test(entrypointSurface)) {
    criteria.push(`${entrypointSurface} exists as a valid Worker module entrypoint.`);
  }

  return criteria;
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

    const workflowEntry = firstExistingRepoPath(
      repoPath,
      moduleSourceExtensions.map((extension) => `src/workflows/weekly.${extension}`),
    );
    if (directory === 'src/workflows/steps' && workflowEntry) surfaces.add(workflowEntry);
  }

  return [...surfaces];
}

export function acceptanceContractReferences(criterion: string) {
  return Array.from(
    new Set(
      criterion.match(
        /(?:^|\s)((?:src|public|migrations|workers|assets)\/[A-Za-z0-9_./-]+|wrangler\.(?:jsonc?|toml)|package\.json|tsconfig\.json|README\.md|\.gitignore|\.env\*?|\.dev\.vars\*?)/g,
      ) ?? [],
    ),
  ).map((match) => match.trim());
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

function serviceBindingRequirementsFromCriterion(criterion: string) {
  const names = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Z0-9_]*)\b.{0,80}\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding)\b/gi,
    /\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding)\s+(?:named\s+|called\s+)?([A-Z][A-Z0-9_]*)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of criterion.matchAll(pattern)) {
      if (match[1] !== match[1].toUpperCase()) continue;
      names.add(match[1].toUpperCase());
    }
  }

  return [...names].map((name) => ({ name, kind: 'service' as const }));
}

function uniqueBindingRequirements(bindings: Array<{ name: string; kind: WorkerBindingKind }>) {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.kind}:${binding.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  const scriptMatches = Array.from(
    context.criterion.matchAll(/\bscripts\.([A-Za-z0-9:_-]+)\b[\s\S]{0,80}?\bexactly(?:\s+as)?\s+["']([^"']+)["']/gi),
  );
  if (!scriptMatches.length) return undefined;

  const gaps: string[] = [];
  const evidence: string[] = [];
  for (const match of scriptMatches) {
    const [, scriptName, expectedCommand] = match;
    const actualCommand = scripts?.[scriptName];

    if (actualCommand !== expectedCommand) {
      gaps.push(
        `package.json scripts.${scriptName} must be exactly "${expectedCommand}"${
          typeof actualCommand === 'string' ? `, but found "${actualCommand}".` : ', but it is missing.'
        }`,
      );
      continue;
    }

    evidence.push(`structured package.json evidence verified scripts.${scriptName} exactly "${expectedCommand}"`);
  }

  if (gaps.length) {
    return {
      passed: false,
      evidence: [],
      gaps,
    };
  }

  return {
    passed: true,
    evidence,
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

function dependencyNames(packageJson: Record<string, unknown> | undefined) {
  if (!packageJson) return [];
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = recordValue(packageJson[key]);
    if (!bucket) continue;
    for (const name of Object.keys(bucket)) names.add(name);
  }
  return [...names];
}

const forbiddenFrontendScaffoldPackages = new Set([
  '@astrojs/cloudflare',
  '@sveltejs/kit',
  '@vitejs/plugin-react',
  '@vitejs/plugin-vue',
  'astro',
  'next',
  'parcel',
  'react',
  'react-dom',
  'react-scripts',
  'rollup',
  'svelte',
  'vite',
  'vue',
  'webpack',
]);

function firstBuildSliceRunnableByWranglerContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'package.json') || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const root = resolve(target.repoPath);
  const packageJson = packageRecord(target.repoPath);
  const scripts = recordValue(packageJson?.scripts) ?? {};
  const dependencies = dependencyNames(packageJson);
  const config = wranglerJsonConfig(target.repoPath);
  const gaps: string[] = [];

  if (typeof scripts.dev !== 'string' || !/\bwrangler\s+dev\b/.test(scripts.dev) || !/--env\s+staging\b/.test(scripts.dev)) {
    gaps.push('package.json scripts.dev must run wrangler dev --env staging for local scaffold validation.');
  }
  if (
    typeof scripts.typecheck !== 'string' ||
    (!/\btsc\s+--noEmit\b/.test(scripts.typecheck) && !/\bnode\s+scripts\/check-js\.js\b/.test(scripts.typecheck))
  ) {
    gaps.push('package.json scripts.typecheck must run TypeScript or node --check validation without requiring a frontend build step.');
  }
  const frontendBuildScripts = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([, command]) => /\b(vite|next|react-scripts|webpack|rollup|parcel|astro|svelte-kit)\b/i.test(command));
  if (frontendBuildScripts.length) {
    gaps.push(`package.json must not require frontend framework build scripts in T01: ${frontendBuildScripts.map(([name]) => name).join(', ')}.`);
  }

  const forbiddenDependencies = dependencies.filter((name) => forbiddenFrontendScaffoldPackages.has(name));
  if (forbiddenDependencies.length) {
    gaps.push(`package.json must not include React/Vite/frontend framework dependencies in T01: ${forbiddenDependencies.join(', ')}.`);
  }

  if (!config) {
    gaps.push('wrangler.jsonc must be valid JSONC for scaffold validation.');
  } else {
    if (typeof config.main !== 'string' || !/^src\/index\.(?:js|ts)$/.test(config.main)) {
      gaps.push('wrangler.jsonc main must point to src/index.js or src/index.ts for the first Worker slice.');
    }
    const pagesKeys = ['pages', 'pages_build_output_dir', 'pages_build', 'functions', 'pages_functions'];
    const presentPagesKeys = pagesKeys.filter((key) => Object.prototype.hasOwnProperty.call(config, key));
    if (presentPagesKeys.length) gaps.push(`wrangler.jsonc must not configure Pages in T01: ${presentPagesKeys.join(', ')}.`);
    if (Array.isArray(config.d1_databases) && config.d1_databases.length) {
      gaps.push('wrangler.jsonc must not require D1 databases or migrations in the first scaffold slice.');
    }
  }

  for (const forbiddenPath of ['migrations', 'functions']) {
    if (existsSync(join(root, forbiddenPath))) gaps.push(`${forbiddenPath}/ must not be required by the first Worker scaffold slice.`);
  }
  for (const publicFile of ['public/index.html', 'public/styles.css', 'public/app.js']) {
    if (taskBoundarySurfaces(target.repoPath, target.task).includes(publicFile)) {
      gaps.push(`${publicFile} must not be owned by the first engineer scaffold slice.`);
    }
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [
      'structured package.json/wrangler evidence verified T01 is runnable by Wrangler without database migrations, Pages, React/Vite, or public UI files',
    ],
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

  const namedBindingCandidates: Array<{ name: string; kind: WorkerBindingKind }> = [
    { name: 'DB', kind: 'd1' },
    { name: 'ARTIFACTS', kind: 'r2' },
    { name: 'WEEKLY_WORKFLOW', kind: 'workflow' },
    { name: 'AI', kind: 'ai' },
    { name: 'ASSETS', kind: 'assets' },
  ];
  const requiredBindings = uniqueBindingRequirements(
    namedBindingCandidates
      .filter((binding) => new RegExp(`\\b${binding.name}\\b`, 'i').test(context.criterion))
      .concat(serviceBindingRequirementsFromCriterion(context.criterion)),
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

function workerConfigAiBindingContractEvidence(context: AcceptanceContractContext) {
  const target = ensureTaskRepo(context);
  if (!target || !taskOwns(context, 'wrangler.jsonc')) return undefined;

  const config = wranglerJsonConfig(target.repoPath);
  if (!config) {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc is not valid JSONC, so Workers AI binding could not be verified.'],
    };
  }

  const ai = recordValue(config.ai);
  if (ai?.binding !== 'AI') {
    return {
      passed: false,
      evidence: [],
      gaps: ['wrangler.jsonc must configure Workers AI with ai.binding set to "AI".'],
    };
  }

  return {
    passed: true,
    evidence: ['structured wrangler.jsonc evidence verified Workers AI binding "AI"'],
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
  const requiredGroups: Array<{ label: string; patterns: RegExp[]; mode?: 'all' | 'any' }> = [
    { label: 'dependencies', patterns: [/^node_modules\/?$/m] },
    { label: 'Wrangler local state', patterns: [/^\.wrangler\/?$/m] },
    { label: 'env files', patterns: [/^\.env\*?$/m, /^\.dev\.vars\*?$/m] },
  ];
  if (/\.delivery|delivery artifacts?/i.test(context.criterion)) {
    requiredGroups.push({ label: 'delivery artifacts', patterns: [/^\.delivery\/?$/m] });
  }
  if (/cpuprofile|startup profiles?/i.test(context.criterion)) {
    requiredGroups.push({ label: 'startup profiles', patterns: [/^\*\.cpuprofile$/m] });
  }
  if (/\bgenerated secrets?\b/i.test(context.criterion)) {
    requiredGroups.push({
      label: 'generated secrets',
      patterns: [/^(?:\.secrets\*?|\.secrets\/?|secrets\/?|generated-secrets\/?|\*\.secrets?|\*\.pem|\*\.key)$/m],
    });
  }
  if (/\bcache\b/i.test(context.criterion)) {
    requiredGroups.push({ label: 'cache artifacts', patterns: [/^\.cache\/?$/m, /^cache\/?$/m], mode: 'any' });
  }
  if (/\bbuild\b|\bruntime artifacts?\b/i.test(context.criterion)) {
    requiredGroups.push({ label: 'build/runtime artifacts', patterns: [/^dist\/?$/m, /^build\/?$/m] });
  }

  for (const group of requiredGroups) {
    const passed =
      group.mode === 'any' ? group.patterns.some((pattern) => pattern.test(source)) : group.patterns.every((pattern) => pattern.test(source));
    if (!passed) gaps.push(`.gitignore must exclude ${group.label}.`);
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
    id: 'worker.scaffold.firstSliceRunnable',
    title: 'First Worker slice is Wrangler-runnable',
    surfaces: ['package.json', 'wrangler.jsonc', 'src/index.ts'],
    matches: ({ criterion }) =>
      /\bfirst build slice\b/i.test(criterion) &&
      /\bstructurally runnable by Wrangler\b/i.test(criterion) &&
      /\bwithout requiring\b/i.test(criterion),
    evaluate: firstBuildSliceRunnableByWranglerContractEvidence,
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
    id: 'worker.config.aiBinding',
    title: 'Workers AI binding config',
    surfaces: ['wrangler.jsonc'],
    matches: ({ criterion }) => /\bwrangler\.jsonc\b/i.test(criterion) && /\bWorkers AI\b/i.test(criterion) && /\bbinding\s+AI\b/i.test(criterion),
    evaluate: workerConfigAiBindingContractEvidence,
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
      /\bsrc\/index\.(js|ts)\b/i.test(criterion) &&
      /\bvalid Worker module entrypoint\b|\bvalid module Worker entrypoint\b|\bminimal Worker module entrypoint\b|\bloaded by Wrangler\b|\bWrangler local validation\b|\bbasic response\b/i.test(
        criterion,
      ),
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

export function workerScaffoldAcceptanceContractIdForCriterion(criterion: string) {
  const scriptMatch = criterion.match(/\bpackage\.json\b[\s\S]{0,120}\bscripts\.([A-Za-z0-9:_-]+)\b/i);
  if (scriptMatch) return `package.scripts.${scriptMatch[1]}`;

  const context: AcceptanceContractContext = { criterion, performed: [] };
  return workerScaffoldAcceptanceContracts.find((contract) => contract.matches(context))?.id;
}

const acceptanceCriterionStopWords = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'using',
  'uses',
  'use',
  'when',
  'then',
  'than',
  'only',
  'each',
  'every',
  'after',
  'before',
  'through',
  'without',
  'within',
  'must',
  'should',
  'can',
  'will',
  'does',
  'not',
  'are',
  'is',
  'be',
  'by',
  'or',
  'as',
  'to',
  'in',
  'on',
  'of',
  'a',
  'an',
]);

function normalizeAcceptanceEvidenceText(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9/_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function acceptanceCriterionTokens(criterion: string) {
  return Array.from(
    new Set(
      normalizeAcceptanceEvidenceText(criterion)
        .split(/\s+/)
        .map((token) => token.replace(/^["'`]+|["'`,.;:]+$/g, ''))
        .filter((token) => token.length >= 3)
        .filter((token) => !acceptanceCriterionStopWords.has(token))
        .filter((token) => !/^\d+$/.test(token)),
    ),
  );
}

function providerAdapterBehaviorCriterion(criterion: string) {
  return /\b(?:configured-state validation|missing keyed secrets?|provider adapter failures?|provider_error|timeout_or_network_error|client-safe messages?|raw upstream response body snippets?|missing_binding|client-safe RunResult|unrelated model runs)\b/i.test(
    criterion,
  );
}

function repoFileContents(repoPath: string, paths: Array<string | undefined>) {
  return paths
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .map((path) => {
      const normalizedPath = normalizeDeliveryPathReference(path);
      const fullPath = isAbsolute(normalizedPath) ? normalizedPath : join(resolve(repoPath), normalizedPath);
      if (!existsSync(fullPath)) return undefined;
      return {
        path: normalizedPath,
        content: readFileSync(fullPath, 'utf8'),
      };
    })
    .filter((file): file is { path: string; content: string } => Boolean(file));
}

function acceptanceEvidenceFiles(repoPath?: string, task?: AcceptanceContractTask) {
  if (!repoPath || !task) return [];
  return repoFileContents(repoPath, taskBoundarySurfaces(repoPath, task));
}

function acceptanceCriterionCommandEvidence(criterion: string, performed: string[]) {
  const text = criterion.toLowerCase();
  const evidence = performed.join('\n').toLowerCase();

  if (
    providerAdapterBehaviorCriterion(criterion) &&
    /\bnpm run test passed\b|\bvitest\b/.test(evidence) &&
    /\b(provider adapters?|provider_error|timeout_or_network_error|missing keyed secrets?|missing workers ai binding|execute model|client-safe)\b/.test(
      evidence,
    )
  ) {
    return 'provider behavior test evidence covered provider adapter failure and client-safe error criteria';
  }
  if (/\b(typecheck|tsc|typescript)\b/.test(text) && /\b(typecheck|tsc)\b/.test(evidence)) {
    return 'verification command covered TypeScript/typecheck criterion';
  }
  if (/\btest(s|ing)?\b/.test(text) && /\btest\b/.test(evidence)) {
    return 'verification command covered test criterion';
  }
  if (/\bbuild\b/.test(text) && /\bbuild\b/.test(evidence)) {
    return 'verification command covered build criterion';
  }
  if (/\bwrangler dev\b/.test(text) && /\bwrangler dev\b/.test(evidence)) {
    return 'verification command covered wrangler dev criterion';
  }
  if (/\bhealth\b|\/health\b|http 200|status 200/.test(text) && /\bhealth\b|\/health\b|http 200|status 200/.test(evidence)) {
    return 'verification command covered HTTP health/status criterion';
  }

  return undefined;
}

function acceptanceCriterionFileEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (isBehaviorLikeAcceptanceCriterion(criterion)) return undefined;

  const files = acceptanceEvidenceFiles(repoPath, task);
  if (!files.length) return undefined;

  const references = acceptanceContractReferences(criterion);
  const referencedFiles = references.length
    ? files.filter((file) => references.some((reference) => file.path === reference || file.path.endsWith(reference)))
    : files;
  if (references.length && !referencedFiles.length) return undefined;

  const corpus = normalizeAcceptanceEvidenceText(
    referencedFiles.map((file) => `${file.path}\n${file.content}`).join('\n'),
  );
  const tokens = acceptanceCriterionTokens(criterion);
  if (!tokens.length) return undefined;

  const matched = tokens.filter((token) => corpus.includes(token));
  const required = tokens.length <= 6 ? Math.max(2, tokens.length - 1) : Math.ceil(tokens.length * 0.58);
  if (matched.length < required) return undefined;

  return `file evidence covered ${matched.length}/${tokens.length} acceptance tokens in ${referencedFiles
    .map((file) => file.path)
    .slice(0, 4)
    .join(', ')}`;
}

function workerScaffoldProtectedApiContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bscaffold\b/i.test(criterion) || !/\bprotected endpoints?\b/i.test(criterion)) return undefined;
  if (!/\bauth\.js\b/i.test(criterion) || !/\bfail closed\b/i.test(criterion)) return undefined;

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  if (!/(api_not_ready|protected API endpoints? are intentionally unavailable|status:\s*50[13]|501)/i.test(source)) {
    gaps.push(`${indexPath} must keep protected API endpoints unavailable in the scaffold.`);
  }
  if (!/ADMIN_TOKEN[\s\S]{0,240}(secret|missing|invalid|fail closed)|fail closed[\s\S]{0,240}ADMIN_TOKEN/i.test(source)) {
    gaps.push(`${indexPath} must carry forward the later ADMIN_TOKEN fail-closed requirement.`);
  }
  if (!/\bauth\.js\b/i.test(source)) {
    gaps.push(`${indexPath} must point protected API readiness to the later auth.js task.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured scaffold evidence verified protected APIs stay unavailable until auth.js in ${indexPath}`],
    gaps: [],
  };
}

function workerEntrypointExportContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bsrc\/index\.(js|ts)\b/i.test(criterion)) return undefined;
  if (
    !/\b(?:Worker module entrypoint|Worker fetch handler|fetch handler|concrete entrypoint|runtime validation|default)\b/i.test(
      criterion,
    ) ||
    !/\bfetch\b/i.test(criterion) ||
    !/\bWeeklyWorkflow\b/i.test(criterion)
  ) {
    return undefined;
  }

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  const exportsFetch =
    /export\s+(?:async\s+)?function\s+fetch\s*\(/m.test(source) ||
    /export\s+default\s+\{[\s\S]*\bfetch\b[\s\S]*\}/m.test(source) ||
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[\s\S]*\bfetch\s*(?:\(|:)[\s\S]*\}[\s\S]*export\s+default\s+\1\s*;/m.test(
      source,
    );
  if (!exportsFetch) {
    gaps.push(`${indexPath} must export a default Worker object with a fetch handler.`);
  }
  if (!/\bexport\s+class\s+WeeklyWorkflow\b/.test(source)) {
    gaps.push(`${indexPath} must export a WeeklyWorkflow class stub.`);
  }
  if (/\bextends\s+WorkflowEntrypoint\b/.test(source) && !/from\s+['"]cloudflare:workers['"]/.test(source)) {
    gaps.push(`${indexPath} extends WorkflowEntrypoint but does not import it from cloudflare:workers.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured Worker entrypoint evidence verified default fetch handler and WeeklyWorkflow export in ${indexPath}`],
    gaps: [],
  };
}

function workerStaticAssetFallbackContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (
    !/\b(?:static asset fallback|ASSETS\.fetch|env\.ASSETS|ASSETS binding|Non-API (?:routes?|requests?)|falls through non-API)\b/i.test(
      criterion,
    )
  ) {
    return undefined;
  }
  if (!/\b(?:public\/index\.html|related assets|same Worker|static assets?)\b/i.test(criterion)) return undefined;

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  const callsAssetsFetch =
    /\benv\.ASSETS\.fetch\s*\(\s*request\s*\)/.test(source) ||
    /\bc\.env\.ASSETS\.fetch\s*\(\s*c\.req\.raw\s*\)/.test(source);
  if (!callsAssetsFetch) {
    gaps.push(`${indexPath} must call env.ASSETS.fetch(request) or c.env.ASSETS.fetch(c.req.raw) for the static asset fallback.`);
  }
  const routesApiBeforeFallback =
    /!\s*[^;\n]*\.startsWith\s*\(\s*['"]\/api\/['"]\s*\)/.test(source) ||
    /\bapp\.all\s*\(\s*['"]\/api\/\*['"][\s\S]{0,600}\bapp\.notFound\s*\(/.test(source);
  if (!routesApiBeforeFallback) {
    gaps.push(`${indexPath} must route non-API requests to the static asset fallback before returning API 404s.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured ${indexPath} evidence verified non-API routes fall through to env.ASSETS.fetch(request)`],
    gaps: [],
  };
}

function workerStaticAssetValidationDeferralContractEvidence({
  criterion,
  performed,
  repoPath,
  task,
}: {
  criterion: string;
  performed: string[];
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (
    !/\b(?:does not claim full Wrangler runtime validation|full local Wrangler validation point|configured ASSETS directory|sequenced after T06|designer-owned T06|avoiding engineer ownership of public\/ files)\b/i.test(
      criterion,
    )
  ) {
    return undefined;
  }

  const surfaces = taskBoundarySurfaces(repoPath, task);
  const gaps: string[] = [];
  for (const publicSurface of ['public/index.html', 'public/styles.css', 'public/app.js']) {
    if (surfaces.includes(publicSurface)) {
      gaps.push(`${task.id} must not own ${publicSurface} when static asset runtime validation is intentionally deferred.`);
    }
  }

  const performedText = performed.join('\n');
  if (/\bwrangler\s+(?:dev|deploy)\b|\bwrangler\b[\s\S]{0,80}\b(?:dry-run|--dry-run)\b/i.test(performedText)) {
    gaps.push(`${task.id} must not claim full Wrangler runtime validation before designer-owned public assets exist.`);
  }

  const hasDeferralEvidence = surfaces
    .filter((surface) => /^src\/index\.(js|ts)$/.test(surface) || surface === 'wrangler.jsonc' || surface === 'wrangler.toml')
    .some((surface) => {
      const fullPath = join(resolve(repoPath), surface);
      if (!existsSync(fullPath)) return false;
      const source = readFileSync(fullPath, 'utf8');
      return /T06|designer-owned|designer owned|public\/index\.html|public\/styles\.css|public\/app\.js|does not claim full Wrangler runtime validation|first full local Worker plus static-assets validation/i.test(
        source,
      );
    });
  if (!hasDeferralEvidence) {
    gaps.push(`${task.id} must record static asset runtime validation deferral in a task-owned Worker scaffold file.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured ${task.id} evidence verified static asset runtime validation is deferred until designer-owned public assets exist`],
    gaps: [],
  };
}

function workerTypesContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bsrc\/types\.ts\b/i.test(criterion)) return undefined;
  if (!taskBoundarySurfaces(repoPath, task).includes('src/types.ts')) return undefined;

  const fullPath = join(resolve(repoPath), 'src/types.ts');
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  let inspected = false;

  if (/\bper-model API result shapes\b|\bok true\b|\bok false\b/i.test(criterion)) {
    inspected = true;
    if (!/\bok\s*:\s*true\b/.test(source)) gaps.push('src/types.ts must define an ok: true model result shape.');
    if (!/\bok\s*:\s*false\b/.test(source)) gaps.push('src/types.ts must define an ok: false model result shape.');
    for (const field of ['id', 'label', 'vendor']) {
      if (!new RegExp(`\\b${field}\\s*:\\s*string\\b`).test(source)) {
        gaps.push(`src/types.ts must include ${field}: string on per-model API result shapes.`);
      }
    }
    if (!/\blatency(?:Ms|Millis|Milliseconds)?\s*:\s*number\b/i.test(source)) {
      gaps.push('src/types.ts must include a numeric latency field on per-model API result shapes.');
    }
  }

  if (/\bWorker environment bindings\b/i.test(criterion)) {
    inspected = true;
    if (!/\bAI\s*:\s*[A-Za-z_$][\w$]*/.test(source)) gaps.push('src/types.ts must define an AI binding.');
    if (!/\bASSETS\s*:\s*[A-Za-z_$][\w$]*/.test(source)) gaps.push('src/types.ts must define an ASSETS binding.');
    if (!/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY|ProviderSecret)\b/.test(source)) {
      gaps.push('src/types.ts must include optional provider secret names.');
    }
  }

  const constantExpectations: Array<[string, string]> = [
    ['MAX_MODELS_PER_RUN', '8'],
    ['MAX_USER_PROMPT_CHARS', '100000'],
    ['MAX_REQUEST_BYTES', '262144'],
    ['PROVIDER_TIMEOUT_MS', '60000'],
  ];
  for (const [name, value] of constantExpectations) {
    if (!new RegExp(`\\b${name}\\b`).test(criterion)) continue;
    inspected = true;
    if (!new RegExp(`\\bconst\\s+${name}\\s*=\\s*${value}\\b`).test(source)) {
      gaps.push(`src/types.ts must set ${name} to ${value}.`);
    }
  }

  if (!inspected) return undefined;
  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured src/types.ts evidence verified Worker type contracts and exact request boundary constants'],
    gaps: [],
  };
}

function modelCatalogContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (
    !/\bsrc\/models\.ts\b|\bmodel catalog\b|\bcatalog(?:\s+(?:array|entries?|includes))?\b|\bconfigured status\b|\bconfiguration detection\b|\bAPI-visible model metadata\b/i.test(
      criterion,
    )
  ) {
    return undefined;
  }
  if (!taskBoundarySurfaces(repoPath, task).includes('src/models.ts')) return undefined;

  const fullPath = join(resolve(repoPath), 'src/models.ts');
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  let inspected = false;

  if (/\b(?:catalog array|Workers AI|Anthropic|z\.ai|OpenAI-compatible|openai-compatible)\b/i.test(criterion)) {
    inspected = true;
    if (!/\bexport\s+const\s+\w*CATALOG\w*\s*=|\bexport\s+const\s+\w*MODELS\w*\s*=/i.test(source)) {
      gaps.push('src/models.ts must export a model catalog array.');
    }
    for (const provider of ['workers-ai', 'anthropic', 'openai-compatible']) {
      if (!new RegExp(`provider\\s*:\\s*['"]${provider}['"]`).test(source)) {
        gaps.push(`src/models.ts must include a ${provider} catalog entry.`);
      }
    }
    if (!/vendor\s*:\s*['"]z\.ai['"]/i.test(source) || !/baseUrl\s*:\s*['"]https:\/\/api\.z\.ai\/api\/anthropic['"]/.test(source)) {
      gaps.push('src/models.ts must include z.ai as an Anthropic-compatible catalog entry.');
    }
    if (!/baseUrl\s*:\s*['"]https:\/\/api\.openai\.com\/v1['"]/.test(source)) {
      gaps.push('src/models.ts must include OpenAI-compatible baseUrl https://api.openai.com/v1.');
    }
  }

  if (/\bid, label, vendor, provider, model\b/i.test(criterion)) {
    inspected = true;
    for (const field of ['id', 'label', 'vendor', 'provider', 'model']) {
      if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
        gaps.push(`src/models.ts catalog entries must include ${field}.`);
      }
    }
  }

  if (/\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY|secretKey|keyed models?)\b/i.test(criterion)) {
    inspected = true;
    for (const secret of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY']) {
      if (!new RegExp(`secretKey\\s*:\\s*['"]${secret}['"]`).test(source)) {
        gaps.push(`src/models.ts must reference ${secret} for keyed catalog entries.`);
      }
    }
  }

  if (/\bconfigured status\b|\bnamed secret exists\b/i.test(criterion)) {
    inspected = true;
    if (!/\b(?:deriveConfiguredStatus|isModelConfigured|isConfigured)\b/.test(source)) {
      gaps.push('src/models.ts must export a configured-status helper.');
    }
    if (!/\bmodel\.secretKey\b/.test(source)) {
      gaps.push('src/models.ts must derive keyed model status from model.secretKey.');
    }
    if (!/provider\s*={0,2}\s*['"]workers-ai['"]|\bmodel\.provider\s*={2,3}\s*['"]workers-ai['"]/.test(source)) {
      gaps.push('src/models.ts must treat keyless Workers AI models as configured.');
    }
  }

  if (/\bEnv type exported from src\/contracts\.ts\b|\bad hoc untyped env property names\b/i.test(criterion)) {
    inspected = true;
    const importsEnv = /import\s+type\s*\{[^}]*\bEnv\b[^}]*\}\s+from\s*['"]\.\/contracts['"]/.test(source);
    const usesEnvForDetection =
      /\b(?:deriveConfiguredStatus|isModelConfigured|isConfigured)\s*\([^)]*\benv\s*:\s*(?:Env|ModelConfigurationEnv)\b/.test(source) ||
      /\btype\s+ModelConfigurationEnv\s*=\s*Env\b/.test(source);
    if (!importsEnv || !usesEnvForDetection) {
      gaps.push('src/models.ts must type configuration detection with Env imported from src/contracts.ts.');
    }
    if (/\b(?:Record\s*<\s*string|as\s+any|:\s*any\b|\[\s*key\s*:\s*string\s*\])/.test(source)) {
      gaps.push('src/models.ts must not use untyped string-key env access for configuration detection.');
    }
  }

  if (/\bsecret values\b|\bAPI-visible model metadata\b/i.test(criterion)) {
    inspected = true;
    if (!/\b(?:PublicModel|toPublicModel|getPublicModels)\b/.test(source)) {
      gaps.push('src/models.ts must expose API-visible model metadata through a public model helper/type.');
    }
    const publicModelIncludesSecret =
      /\breturn\s*\{[\s\S]{0,300}\b(?:secretKey|baseUrl)\b/.test(source) ||
      /\breturn\s*\{[\s\S]{0,300}\bmodel\s*:/.test(source);
    if (publicModelIncludesSecret) {
      gaps.push('src/models.ts public model metadata must not include secret values or provider-private fields.');
    }
  }

  if (!inspected) return undefined;
  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured src/models.ts evidence verified Benchmark model catalog provider families and keyed entries'],
    gaps: [],
  };
}

function providerAdapterContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (!taskBoundarySurfaces(repoPath, task).includes('src/providers.ts')) return undefined;
  if (
    !/\bsrc\/providers\.ts\b|\bproviders?\b|\badapters?\b|\bdispatcher\b|\bMAX_TOKENS\b|\benv\.AI\.run\b|\bProviderError\b|\bsecretKey\b|\bBEARER_TOKEN\b|\bsecret\b/i.test(
      criterion,
    )
  ) {
    return undefined;
  }

  const fullPath = join(resolve(repoPath), 'src/providers.ts');
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const errorsPath = join(resolve(repoPath), 'src/errors.ts');
  const errorsSource = existsSync(errorsPath) ? readFileSync(errorsPath, 'utf8') : '';
  const combinedSource = `${source}\n${errorsSource}`;
  const gaps: string[] = [];
  let inspected = false;

  if (/\bMAX_TOKENS\b|\boutput cap\b|\b2048\b/i.test(criterion)) {
    inspected = true;
    if (!/\bMAX_TOKENS\s*=\s*2048\b/.test(source)) {
      gaps.push('src/providers.ts must define MAX_TOKENS as 2048.');
    }
    if (!/\bmax_tokens\s*:\s*MAX_TOKENS\b/.test(source) && !/\bmax_completion_tokens\s*:\s*MAX_TOKENS\b/.test(source)) {
      gaps.push('src/providers.ts must apply MAX_TOKENS to provider output limits.');
    }
  }

  if (/\bworkers-ai\b|\bWorkers AI\b|\benv\.AI\.run\b|\bOpenAI-style choices\b/i.test(criterion)) {
    inspected = true;
    if (!/\benv\.AI\.run\s*\(/.test(source)) {
      gaps.push('src/providers.ts must call env.AI.run for Workers AI models.');
    }
    if (!/\bmessages\b[\s\S]{0,160}\bmax_tokens\s*:\s*MAX_TOKENS\b/.test(source)) {
      gaps.push('src/providers.ts must pass messages and max_tokens: MAX_TOKENS to env.AI.run.');
    }
    if (!/typeof\s+\w+\s*={0,2}\s*['"]string['"]|typeof\s+\w+\s*={0,3}\s*['"]string['"]/.test(source)) {
      gaps.push('src/providers.ts must handle string Workers AI responses.');
    }
    if (!/\bchoices\b/.test(source)) {
      gaps.push('src/providers.ts must handle OpenAI-style choices responses.');
    }
  }

  if (/\breasoning_content\b|\breasoning only\b/i.test(criterion)) {
    inspected = true;
    if (!/\breasoning_content\b/.test(source)) {
      gaps.push('src/providers.ts must inspect reasoning_content.');
    }
    if (!/\[reasoning only\]/i.test(source)) {
      gaps.push('src/providers.ts must label reasoning-only output visibly.');
    }
  }

  if (/\bnormalizes? successful output\b|\binputTokens\b|\boutputTokens\b/i.test(criterion)) {
    inspected = true;
    for (const field of ['text', 'inputTokens', 'outputTokens']) {
      if (!new RegExp(`\\b${field}\\b`).test(source)) {
        gaps.push(`src/providers.ts must normalize successful provider output with ${field}.`);
      }
    }
  }

  if (/\bnormalizes? provider failures\b|\bProviderError\b|\bshared provider error\b/i.test(criterion)) {
    inspected = true;
    if (!/\b(?:normalizeProviderError|normalizeCaughtProviderError|ProviderAdapterError)\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must centralize provider failure normalization.');
    }
    if (!/\b(?:ProviderError|ProviderAdapterError|NormalizedProviderError)\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must use the shared ProviderError shape.');
    }
    for (const provider of ['workers-ai', 'anthropic', 'openai-compatible']) {
      if (!new RegExp(`['"]${provider}['"]`).test(source)) {
        gaps.push(`src/providers.ts must cover ${provider} provider failures.`);
      }
    }
  }

  if (/\bprovider, vendor, model id\b|\boptional HTTP\b|\bstatus\b|\buser-safe\b|\bresult cards\b/i.test(criterion)) {
    inspected = true;
    for (const pattern of [
      ['provider: model.provider', /\bprovider\s*:\s*model\.provider\b|\bthis\.provider\s*=\s*model\.provider\b/],
      ['vendor: model.vendor', /\bvendor\s*:\s*model\.vendor\b|\bthis\.vendor\s*=\s*model\.vendor\b/],
      ['modelId: model.id', /\bmodelId\s*:\s*model\.id\b|\bthis\.modelId\s*=\s*model\.id\b/],
      ['status', /\b(?:httpStatus|status)\b/],
      ['userSafeMessage', /\buserSafeMessage\b/],
    ] as const) {
      if (!pattern[1].test(combinedSource)) gaps.push(`src/providers.ts must include ${pattern[0]} in normalized provider errors.`);
    }
  }

  if (/\bsanitizes?\b|\bBEARER_TOKEN\b|\bauthorization headers?\b|\brequest bodies?\b|\bsecret names?\b|\bAPI keys?\b/i.test(criterion)) {
    inspected = true;
    const sanitizerFunctionPattern = /\b(?:sanitizeProviderMessage|safeExcerpt|sanitize[A-Z]\w*|redact[A-Z]\w*)\b/;
    if (!sanitizerFunctionPattern.test(combinedSource)) {
      gaps.push('src/providers.ts must sanitize provider error messages before returning them.');
    }
    if (!/\bSECRET_(?:VALUE|REDACTION)_PATTERNS\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must define explicit secret redaction patterns.');
    }
    for (const pattern of ['Bearer', 'BEARER_TOKEN', 'authorization', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'body', 'request']) {
      if (!new RegExp(pattern, 'i').test(combinedSource)) {
        gaps.push(`src/providers.ts secret sanitization must cover ${pattern}.`);
      }
    }
    if (!/\.replace\s*\(\s*pattern\b|\breplaceAll\s*\(/.test(combinedSource)) {
      gaps.push('src/providers.ts must apply secret redaction patterns.');
    }
    const returnsSanitizedUserSafeMessage =
      /\buserSafeMessage\s*:\s*(?:userSafeMessage|sanitizeProviderMessage\s*\()/.test(combinedSource) ||
      /\bconst\s+userSafeMessage\s*=\s*sanitizeProviderMessage\s*\([\s\S]{0,800}return\s*\{[\s\S]{0,400}\buserSafeMessage\b/.test(
        combinedSource,
      ) ||
      /\bconst\s+userSafeMessage\s*=[\s\S]{0,300}\b(?:safeExcerpt|sanitizeProviderMessage|sanitize[A-Z]\w*|redact[A-Z]\w*)\s*\(/.test(
        combinedSource,
      ) ||
      /\bnew\s+(?:SanitizedProviderError|ProviderAdapterError)\s*\([\s\S]{0,220}\b(?:userSafeMessage|message|buildProviderError)\b/.test(
        combinedSource,
      ) ||
      /\breturn\s+\{[\s\S]{0,220}\b(?:userSafeMessage|message)\s*:\s*(?:error\.)?\w+[\s\S]{0,80}\}/.test(combinedSource);
    if (!returnsSanitizedUserSafeMessage) {
      gaps.push('src/providers.ts must return only the sanitized userSafeMessage.');
    }
  }

  if (/\bnon-OK provider responses\b|\bSDK exceptions\b|\btimeout failures\b|\bmalformed response shapes\b/i.test(criterion)) {
    inspected = true;
    for (const pattern of [
      ['non-OK HTTP normalization', /\b!response\.ok\b[\s\S]{0,220}\bhttpProviderError\b|\bhttpProviderError\b[\s\S]{0,220}\bProviderAdapterError\b/],
      ['caught exception normalization', /\bcatch\s*\([^)]*\)\s*\{[\s\S]{0,220}\bnormalizeCaughtProviderError\b/],
      ['timeout normalization', /\btimeoutProviderError\b/],
      ['malformed response normalization', /\bmalformedProviderResponseError\b/],
      ['normalized provider error shape', /\b(?:NormalizedProviderError|ProviderAdapterError)\b/],
    ] as const) {
      if (!pattern[1].test(combinedSource)) gaps.push(`src/providers.ts/src/errors.ts must provide ${pattern[0]}.`);
    }
  }

  if (/\bcapped\b|\bapproximately 300\b|\b300 characters\b/i.test(criterion)) {
    inspected = true;
    if (!/\b(?:PROVIDER_(?:ROUTE_)?ERROR_MESSAGE_CHARS|USER_SAFE_MESSAGE_CHARS)\s*=\s*300\b/.test(combinedSource)) {
      gaps.push('src/providers.ts/src/errors.ts must define a 300 character route-safe provider error cap.');
    }
    if (!/\bsanitize\w*\s*\([^)]*(?:300|PROVIDER_(?:ROUTE_)?ERROR_MESSAGE_CHARS)/.test(combinedSource) && !/\.slice\s*\(\s*0\s*,\s*(?:300|PROVIDER_(?:ROUTE_)?ERROR_MESSAGE_CHARS|maxChars)\s*\)/.test(combinedSource)) {
      gaps.push('src/providers.ts/src/errors.ts must cap provider error messages after sanitization.');
    }
  }

  if (/\bstrips stack traces\b|\bauthorization tokens\b|\braw secret values\b|\bfull provider response bodies\b/i.test(criterion)) {
    inspected = true;
    if (!/\bSTACK_TRACE_LINE\b|^\s*at\s+\.\+/m.test(combinedSource)) {
      gaps.push('src/errors.ts must strip stack trace lines from provider error messages.');
    }
    if (!/\bSECRET_(?:VALUE|REDACTION)_PATTERNS\b|\bBearer\b[\s\S]{0,220}\bauthorization\b/i.test(combinedSource)) {
      gaps.push('src/errors.ts must include redaction patterns for authorization tokens and secret markers.');
    }
    if (!/\.replace\s*\(\s*pattern\b|\bsanitizeProviderText\b/.test(combinedSource)) {
      gaps.push('src/errors.ts must apply redaction before returning provider error messages.');
    }
  }

  if (/\bper-model timeout\b|\bWorker-compatible abort\b|\bbounded execution mechanism\b/i.test(criterion)) {
    inspected = true;
    if (!/\b(?:AbortController|setTimeout|Promise\.race)\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must enforce a bounded provider execution timeout.');
    }
    if (!/\btimeoutProviderError\b|\bclassification\s*:\s*['"]timeout['"]/.test(combinedSource)) {
      gaps.push('src/providers.ts/src/errors.ts must normalize provider timeouts.');
    }
    if (!/\bPROVIDER_(?:EXECUTION_)?TIMEOUT_MS\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must use the shared provider timeout constant.');
    }
  }

  if (/\bT04\b|\bper-model failed result\b|\bwithout crashing unrelated model runs\b/i.test(criterion)) {
    inspected = true;
    if (!/\btoRouteProviderError\b|\bNormalizedProviderError\b/.test(combinedSource)) {
      gaps.push('src/errors.ts must expose a route-convertible normalized provider error.');
    }
    if (!/\bthrow\s+(?:normalizeCaughtProviderError|new\s+ProviderAdapterError|httpProviderError|timeoutProviderError|malformedProviderResponseError)\b/.test(combinedSource)) {
      gaps.push('src/providers.ts must throw normalized provider failures for route-level per-model conversion.');
    }
  }

  if (/\bsecretKey\b|\bcatalog secret\b|\bdoes not read provider secrets\b|\bWorker Env contract\b/i.test(criterion)) {
    inspected = true;
    const importsContractsModule =
      /from\s*['"]\.\/contracts['"]/.test(source) && /\bEnv\b/.test(source) && /\bModelCatalogEntry\b/.test(source);
    const importsModelContract =
      /from\s*['"]\.\/models['"]/.test(source) &&
      /\bModelCatalogEntry\b/.test(source) &&
      /\bModelSecretEnv\b/.test(source) &&
      /\b(?:export\s+)?type\s+ProviderEnv\b/.test(source);
    if (!importsContractsModule && !importsModelContract) {
      gaps.push('src/providers.ts must import the model/env contract from src/contracts.ts or src/models.ts.');
    }
    if (!/\bmodel\.secretKey\b/.test(source)) {
      gaps.push('src/providers.ts must use model.secretKey as the catalog-controlled secret name.');
    }
    if (!/\benv\s*\[\s*(?:model\.secretKey|secretKey)\s*\]/.test(source)) {
      gaps.push('src/providers.ts must read provider secrets through env[model.secretKey] or an equivalent secretKey variable.');
    }
    if (/\benv\.(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY)\b/.test(source)) {
      gaps.push('src/providers.ts must not read provider secrets through hard-coded env secret names.');
    }
  }

  if (!inspected) return undefined;
  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: ['structured src/providers.ts evidence verified provider adapter dispatch, normalization, and catalog-scoped secret handling'],
    gaps: [],
  };
}

function workerWorkflowEntrypointContractEvidence({
  criterion,
  repoPath,
  task,
}: {
  criterion: string;
  repoPath?: string;
  task?: AcceptanceContractTask;
}) {
  if (!repoPath || !task) return undefined;
  if (!/\bWeeklyWorkflow\b/i.test(criterion) || !/\bWorkflowEntrypoint\b/i.test(criterion)) return undefined;

  const indexPath = taskBoundarySurfaces(repoPath, task).find((surface) => /^src\/index\.(js|ts)$/.test(surface));
  if (!indexPath) return undefined;

  const fullPath = join(resolve(repoPath), indexPath);
  if (!existsSync(fullPath)) return undefined;

  const source = readFileSync(fullPath, 'utf8');
  const gaps: string[] = [];
  if (!/import\s*\{[^}]*\bWorkflowEntrypoint\b[^}]*\}\s*from\s*['"]cloudflare:workers['"]/.test(source)) {
    gaps.push(`${indexPath} must import WorkflowEntrypoint from cloudflare:workers.`);
  }
  if (!/export\s+class\s+WeeklyWorkflow\s+extends\s+WorkflowEntrypoint\b/.test(source)) {
    gaps.push(`${indexPath} must export class WeeklyWorkflow extends WorkflowEntrypoint.`);
  }

  if (gaps.length) return { passed: false, evidence: [], gaps };

  return {
    passed: true,
    evidence: [`structured WorkflowEntrypoint evidence verified WeeklyWorkflow export in ${indexPath}`],
    gaps: [],
  };
}

export function evaluateAcceptanceCriterion(context: AcceptanceContractContext): AcceptanceContractEvidence {
  const commandEvidence = acceptanceCriterionCommandEvidence(context.criterion, context.performed);
  if (commandEvidence) return { passed: true, evidence: [commandEvidence], gaps: [] };

  const workerScaffoldContractEvidence = evaluateWorkerScaffoldAcceptanceContract(context);
  if (workerScaffoldContractEvidence) return workerScaffoldContractEvidence;

  const scaffoldProtectedApiEvidence = workerScaffoldProtectedApiContractEvidence(context);
  if (scaffoldProtectedApiEvidence) return scaffoldProtectedApiEvidence;

  const workerEntrypointEvidence = workerEntrypointExportContractEvidence(context);
  if (workerEntrypointEvidence) return workerEntrypointEvidence;

  const workerStaticAssetFallbackEvidence = workerStaticAssetFallbackContractEvidence(context);
  if (workerStaticAssetFallbackEvidence) return workerStaticAssetFallbackEvidence;

  const workerStaticAssetValidationDeferralEvidence = workerStaticAssetValidationDeferralContractEvidence(context);
  if (workerStaticAssetValidationDeferralEvidence) return workerStaticAssetValidationDeferralEvidence;

  const workerTypesEvidence = workerTypesContractEvidence(context);
  if (workerTypesEvidence) return workerTypesEvidence;

  const modelCatalogEvidence = modelCatalogContractEvidence(context);
  if (modelCatalogEvidence) return modelCatalogEvidence;

  const providerAdapterEvidence = providerAdapterContractEvidence(context);
  if (providerAdapterEvidence) return providerAdapterEvidence;

  const workflowEntrypointEvidence = workerWorkflowEntrypointContractEvidence(context);
  if (workflowEntrypointEvidence) return workflowEntrypointEvidence;

  const fileEvidence = acceptanceCriterionFileEvidence(context);
  if (fileEvidence) return { passed: true, evidence: [fileEvidence], gaps: [] };

  return {
    passed: false,
    evidence: [],
    gaps: [`Acceptance criterion not verified by automated checks or task-boundary file evidence: ${context.criterion}`],
  };
}

export function acceptanceContractsForCriteria({
  repoPath,
  task,
  verification,
  criteria,
  contractIdForCriterion,
}: {
  repoPath?: string;
  task: AcceptanceContractTask;
  verification: { performed: string[]; missing: string[] };
  criteria: string[];
  contractIdForCriterion: (criterion: string, index: number) => string;
}): AcceptanceContractRecord[] {
  return criteria.map((criterion, index) => {
    const result = evaluateAcceptanceCriterion({
      criterion,
      performed: verification.performed,
      repoPath,
      task,
    });
    return {
      id: contractIdForCriterion(criterion, index),
      criterion,
      status: result.passed ? 'verified' : 'unverified',
      evidence: result.evidence,
      gaps: result.gaps,
    };
  });
}

export function verificationWithAcceptanceContractGaps({
  repoPath,
  task,
  verification,
  criteria,
  missingOwnedSurfacePaths,
}: {
  repoPath?: string;
  task: AcceptanceContractTask;
  verification: { performed: string[]; missing: string[] };
  criteria: string[];
  missingOwnedSurfacePaths: string[];
}) {
  const missing = new Set(verification.missing);
  if (repoPath) {
    for (const path of missingOwnedSurfacePaths) {
      missing.add(`Owned surface missing after implementation: ${path}`);
    }
  }
  for (const criterion of criteria) {
    if (!evaluateAcceptanceCriterion({ criterion, performed: verification.performed, repoPath, task }).passed) {
      missing.add(`Acceptance criterion not verified by automated checks: ${criterion}`);
    }
  }

  return {
    performed: verification.performed,
    missing: [...missing],
  };
}
