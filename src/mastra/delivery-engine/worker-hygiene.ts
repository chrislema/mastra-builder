import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeDeliveryPathReference } from './checks';
import { currentWorkerCompatibilityDate } from './worker-compatibility-date';
import type { Task } from './workflow-schemas';

export const workerConfigSurfacePaths = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const;

export type WorkerHygieneTaskGuards = {
  taskCanConfigureWorkerConfig?: (repoPath: string, task: Task) => boolean;
  taskCanConfigureWorkersAi?: (repoPath: string, task: Task) => boolean;
  taskOwnsPackageManifest?: (task: Task) => boolean;
  repoUsesTypeScriptWorkerSource?: (repoPath: string, task?: Task) => boolean;
};

function readJsonArtifact(repoPath: string, artifactPath: string) {
  const fullPath = resolve(repoPath, artifactPath);
  if (!existsSync(fullPath)) return undefined;
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function stripJsoncComments(text: string) {
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

export function parseWranglerJsonConfig(text: string) {
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

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function tomlArrayStringValues(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function firstTomlBooleanValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, 'm').exec(text);
  return match ? match[1] === 'true' : undefined;
}

function firstTomlNumberValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`, 'm').exec(text);
  return match ? Number(match[1]) : undefined;
}

export function firstTomlStringValue(text: string, key: string) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text);
  return match?.[1];
}

function tomlSectionBody(text: string, sectionName: string) {
  const lines = text.split(/\r?\n/);
  const body: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      if (inSection) break;
      inSection = section[1] === sectionName;
      continue;
    }

    if (inSection) body.push(line);
  }

  return inSection || body.length ? body.join('\n') : undefined;
}

export function tomlArrayTableBodies(text: string, tableName: string) {
  const bodies: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] | undefined;

  for (const line of lines) {
    const arrayTable = line.match(/^\s*\[\[([^\]]+)\]\]\s*$/);
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (arrayTable || table) {
      if (current) bodies.push(current.join('\n'));
      current = arrayTable?.[1] === tableName ? [] : undefined;
      continue;
    }

    if (current) current.push(line);
  }

  if (current) bodies.push(current.join('\n'));
  return bodies;
}

function tomlSectionKeyNames(text: string, sectionName: string) {
  const body = tomlSectionBody(text, sectionName);
  if (body === undefined) return [];
  return Array.from(body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=/gm)).map((match) => match[1]);
}

function tomlHasEnvironment(text: string, environmentName: string) {
  const escaped = environmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\[?env\\.${escaped}(?:\\.|\\])`, 'm').test(text);
}

function isoDateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }

  return { year, month, day, time };
}

export function workerConfigTaskPacketPolicy() {
  return {
    schema: './node_modules/wrangler/config-schema.json',
    compatibility_date: currentWorkerCompatibilityDate(),
    compatibility_flags: ['nodejs_compat'],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    static_assets: {
      when_public_directory_exists: {
        directory: './public',
        binding: 'ASSETS',
      },
    },
    deployment_environments: {
      required: ['staging', 'production'],
      staging_dev_command: 'wrangler dev --env staging',
      staging_d1_migration_command: 'wrangler d1 migrations apply <database> --env staging --local',
      production_dry_run_command: 'wrangler deploy --dry-run --env production',
      production_deploy_command: 'wrangler deploy --env production',
      note: 'Wrangler bindings and vars are non-inheritable, so mirror required binding names and required vars inside env.staging and env.production.',
    },
    generated_types: {
      command: 'wrangler types',
      output: 'worker-configuration.d.ts',
      tsconfig_include: ['worker-configuration.d.ts'],
      tsconfig_types: ['node'],
    },
  };
}

function workerSourceSurfaceIsTypeScript(surface: string) {
  const normalized = surface.toLowerCase();
  if (/\.d\.(?:ts|mts|cts)$/.test(normalized)) return false;
  return /\.(?:ts|tsx|mts|cts)$/.test(normalized);
}

function workerSourceSurfaceIsJavaScriptOrTypeScript(surface: string) {
  return /\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/.test(surface);
}

function workerSourceSurfaceIsConcrete(surface: string) {
  if (surface === 'src/**' || surface === 'workers/**') return true;
  if (surface === 'worker.js' || surface === 'worker.mjs' || surface === 'worker.ts') return true;
  return (
    (surface.startsWith('src/') || surface.startsWith('workers/')) &&
    workerSourceSurfaceIsJavaScriptOrTypeScript(surface)
  );
}

function effectiveOwnedSurfaces(task: Task) {
  const surfaces = new Set(task.owned_surfaces);
  const taskText = [task.deliverable, ...task.acceptance_criteria].join('\n');

  if (/\bsrc\/\s+directories\b|\bproject structure\b|\bsrc\/\s+directories for\b/i.test(taskText)) {
    surfaces.add('src/**');
  }

  return [...surfaces];
}

function normalizedOwnedSurfaces(task: Task) {
  return effectiveOwnedSurfaces(task).map((surface) => normalizeDeliveryPathReference(surface)).filter(Boolean);
}

function taskOwnsPackageManifestFallback(task: Task) {
  return normalizedOwnedSurfaces(task).some((surface) => surface === 'package.json' || surface === 'package-lock.json');
}

function taskCanConfigureWorkerConfigFallback(_repoPath: string, task: Task) {
  return normalizedOwnedSurfaces(task).some((surface) =>
    (workerConfigSurfacePaths as readonly string[]).includes(surface),
  );
}

function taskCanConfigureWorkersAiFallback(_repoPath: string, task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) => (workerConfigSurfacePaths as readonly string[]).includes(surface) || workerSourceSurfaceIsConcrete(surface),
  );
}

function taskOwnsTypeScriptWorkerSourceFallback(task: Task) {
  return normalizedOwnedSurfaces(task).some(
    (surface) =>
      surface === 'src/**' ||
      surface === 'workers/**' ||
      ((surface.startsWith('src/') || surface.startsWith('workers/') || surface.startsWith('worker.')) &&
        workerSourceSurfaceIsTypeScript(surface)),
  );
}

function workerSourceSearchRoots(repoPath: string) {
  const root = resolve(repoPath);
  return [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.js'),
    join(root, 'worker.mjs'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];
}

function sourceTextUsesWorkersAi(text: string) {
  return [
    /\benv\s*\??\.\s*AI\b/,
    /\benv\s*\[\s*['"]AI['"]\s*\]/,
    /\bconst\s*\{[^}]*\bAI\b[^}]*\}\s*=\s*(?:\w+\.)?env\b/,
    /\b(?:const|let|var)\s+\w+\s*=\s*(?:\w+\.)?env\s*\??\.\s*AI\b/,
    /\bAI\s*\??\s*:\s*Ai\b/,
    /\bAI\s*\.\s*run\s*\(/,
    /\bWorkersAiClient\b/,
    /\bcreateAiClient\b/,
    /\bfrom\s+['"](?:\.{1,2}\/)*ai\/client['"]/,
  ].some((pattern) => pattern.test(text));
}

function sourceTreeUsesWorkersAi(rootPath: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return sourceTextUsesWorkersAi(readFileSync(rootPath, 'utf8'));
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeUsesWorkersAi(path, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (sourceTextUsesWorkersAi(readFileSync(path, 'utf8'))) return true;
    } catch {
      continue;
    }
  }

  return false;
}

export function repoSourceUsesWorkersAi(repoPath: string) {
  const scanned = { count: 0 };
  return workerSourceSearchRoots(repoPath).some((sourceRoot) => sourceTreeUsesWorkersAi(sourceRoot, scanned));
}

function wranglerTomlHasWorkersAiBinding(text: string) {
  let inAiSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue;
    const line = rawLine.replace(/\s+#.*$/, '');
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inAiSection = section[1] === 'ai';
      continue;
    }
    if (inAiSection && /^\s*binding\s*=\s*["']AI["']\s*$/.test(line)) return true;
  }
  return false;
}

function wranglerJsonHasWorkersAiBinding(text: string) {
  const withoutLineComments = text.replace(/(^|[^:])\/\/.*$/gm, '$1');
  try {
    const parsed = JSON.parse(withoutLineComments) as { ai?: { binding?: unknown } };
    if (parsed.ai?.binding === 'AI') return true;
  } catch {
    // Fall back to a narrow regex for JSONC with trailing commas.
  }
  return /"ai"\s*:\s*\{[\s\S]*?"binding"\s*:\s*"AI"/.test(text);
}

export function workerConfigPath(repoPath: string) {
  const root = resolve(repoPath);
  return workerConfigSurfacePaths.map((file) => join(root, file)).find((path) => existsSync(path));
}

export function wranglerConfigHasWorkersAiBinding(repoPath: string) {
  const configPath = workerConfigPath(repoPath);
  if (!configPath) return false;
  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return wranglerTomlHasWorkersAiBinding(text);
  return wranglerJsonHasWorkersAiBinding(text);
}

function sourceTreeContainsText(rootPath: string, needle: string, scanned = { count: 0 }): boolean {
  if (!existsSync(rootPath) || scanned.count > 150) return false;

  const rootStat = statSync(rootPath);
  if (rootStat.isFile()) {
    if (!/\.[cm]?[jt]sx?$/.test(rootPath)) return false;
    scanned.count += 1;
    if (scanned.count > 150) return false;
    try {
      return readFileSync(rootPath, 'utf8').includes(needle);
    } catch {
      return false;
    }
  }

  if (!rootStat.isDirectory()) return false;

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.delivery') continue;

    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (sourceTreeContainsText(path, needle, scanned)) return true;
      continue;
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    scanned.count += 1;
    if (scanned.count > 150) return false;

    try {
      if (readFileSync(path, 'utf8').includes(needle)) return true;
    } catch {
      continue;
    }
  }

  return false;
}

function workerEnvMarksAiOptional(repoPath: string) {
  const root = resolve(repoPath);
  const sourceRoots = [
    join(root, 'src'),
    join(root, 'workers'),
    join(root, 'worker.ts'),
    join(root, 'worker.mts'),
    join(root, 'worker.cts'),
  ];

  return sourceRoots.some((sourceRoot) => sourceTreeContainsText(sourceRoot, 'AI?: Ai', { count: 0 }));
}

export function workersAiBindingGaps(repoPath: string, task?: Task, guards: WorkerHygieneTaskGuards = {}) {
  if (!repoSourceUsesWorkersAi(repoPath)) return [];
  const canConfigureWorkersAi = guards.taskCanConfigureWorkersAi ?? taskCanConfigureWorkersAiFallback;
  if (task && !canConfigureWorkersAi(repoPath, task)) return [];

  const gaps: string[] = [];
  if (!wranglerConfigHasWorkersAiBinding(repoPath)) {
    gaps.push(
      'Workers AI source is present, but the Wrangler config does not contain an active AI binding named "AI" (`"ai": { "binding": "AI" }` in wrangler.jsonc or `[ai] binding = "AI"` in TOML).',
    );
  }
  if (workerEnvMarksAiOptional(repoPath)) {
    gaps.push('Worker Env marks AI as optional (AI?: Ai); AI-backed product behavior needs Env.AI to be a required binding.');
  }
  return gaps;
}

function workerCompatibilityDateGaps(value: unknown) {
  if (typeof value !== 'string') {
    return [`compatibility_date is missing; set it to today's date (${currentWorkerCompatibilityDate()}) for new Worker projects.`];
  }

  const parsed = isoDateParts(value);
  if (!parsed) {
    return [`compatibility_date "${value}" is not a valid YYYY-MM-DD date.`];
  }

  const today = isoDateParts(currentWorkerCompatibilityDate());
  if (!today) return [];

  const ageDays = Math.floor((today.time - parsed.time) / 86_400_000);
  if (ageDays < 0) {
    return [
      `compatibility_date "${value}" is in the future; use today's date (${currentWorkerCompatibilityDate()}) or a recent released date.`,
    ];
  }
  if (ageDays > 30) {
    return [
      `compatibility_date "${value}" is stale by ${ageDays} days; set it to today's date (${currentWorkerCompatibilityDate()}) or a date within the last 30 days.`,
    ];
  }

  return [];
}

function observabilityConfigGaps(observability: Record<string, unknown> | undefined) {
  const gaps: string[] = [];
  if (!observability) {
    return ['observability is missing; enable Worker observability explicitly with enabled=true and a head_sampling_rate.'];
  }

  if (observability.enabled !== true) {
    gaps.push('observability.enabled must be true for Worker logs/traces.');
  }

  const samplingRate = observability.head_sampling_rate;
  if (typeof samplingRate !== 'number' || !Number.isFinite(samplingRate) || samplingRate <= 0 || samplingRate > 1) {
    gaps.push('observability.head_sampling_rate must be an explicit number greater than 0 and at most 1.');
  }

  return gaps;
}

function workerNameGaps(name: unknown) {
  if (typeof name !== 'string' || !name.trim()) {
    return ['name is missing; set it to the Cloudflare Worker service name used by Wrangler.'];
  }

  if (name !== name.trim()) {
    return [`name "${name}" has leading or trailing whitespace; use "${name.trim()}".`];
  }

  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return [`name "${name}" must be a single Worker service name using only letters, numbers, underscores, and hyphens.`];
  }

  return [];
}

function workerMainEntrypointGaps(repoPath: string, main: unknown) {
  if (typeof main !== 'string' || !main.trim()) {
    return ['main is missing; set it to the Worker entrypoint file used by Wrangler local validation.'];
  }

  const normalized = normalizeDeliveryPathReference(main);
  if (!normalized || isAbsolute(normalized)) {
    return [`main "${main}" must be a repo-relative Worker entrypoint path.`];
  }

  if (!existsSync(join(resolve(repoPath), normalized))) {
    return [`main "${normalized}" does not exist; Wrangler local validation would start the wrong or missing Worker entrypoint.`];
  }

  return [];
}

function relativeWorkerConfigPath(repoPath: string, configPath: string) {
  const root = resolve(repoPath);
  return configPath.startsWith(`${root}/`) ? configPath.slice(root.length + 1) : configPath;
}

export function packageDependencyNames(repoPath: string) {
  const parsed = readJsonArtifact(repoPath, 'package.json');
  if (!parsed || typeof parsed !== 'object') return [];

  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = (parsed as Record<string, unknown>)[key];
    if (!bucket || typeof bucket !== 'object') continue;
    for (const name of Object.keys(bucket)) names.add(name);
  }

  return [...names].sort();
}

export function repoLooksLikeWorkerProject(repoPath: string) {
  const root = resolve(repoPath);
  const packageJson = packageRecord(repoPath);
  const scripts = recordValue(packageJson?.scripts) ?? {};
  return (
    Boolean(workerConfigPath(repoPath)) ||
    existsSync(join(root, 'src', 'index.ts')) ||
    existsSync(join(root, 'src', 'index.js')) ||
    existsSync(join(root, 'src', 'index.mjs')) ||
    existsSync(join(root, 'src', 'env.ts')) ||
    existsSync(join(root, 'worker.js')) ||
    existsSync(join(root, 'worker.mjs')) ||
    existsSync(join(root, 'workers')) ||
    existsSync(join(root, 'worker-configuration.d.ts')) ||
    (typeof scripts.dev === 'string' && /\bwrangler\s+dev\b/.test(scripts.dev)) ||
    packageDependencyNames(repoPath).includes('wrangler')
  );
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
  source: string;
}

function workerEnvBindingKind(name: string, typeText: string): WorkerBindingKind | undefined {
  if (/\bAi\b/.test(typeText)) return 'ai';
  if (name === 'ASSETS' && /\bFetcher\b/.test(typeText)) return 'assets';
  if (/\bD1Database\b/.test(typeText)) return 'd1';
  if (/\bDurableObjectNamespace\b/.test(typeText)) return 'durable_object';
  if (/\bFetcher\b|\bService\b/.test(typeText)) return 'service';
  if (/\bHyperdrive\b/.test(typeText)) return 'hyperdrive';
  if (/\bKVNamespace\b/.test(typeText)) return 'kv';
  if (/\bQueue\b/.test(typeText)) return 'queue';
  if (/\bR2Bucket\b/.test(typeText)) return 'r2';
  if (/\bVectorizeIndex\b/.test(typeText)) return 'vectorize';
  if (/\bWorkflow\b/.test(typeText)) return 'workflow';
  return undefined;
}

function workerEnvSourcePath(repoPath: string) {
  return ['worker-configuration.d.ts', 'src/env.ts', 'src/index.ts']
    .map((path) => join(resolve(repoPath), path))
    .find((path) => existsSync(path));
}

function workerEnvBindingDeclarations(repoPath: string): WorkerBindingDeclaration[] {
  const envPath = workerEnvSourcePath(repoPath);
  if (!envPath) return [];

  const source = readFileSync(envPath, 'utf8');
  const body = source.match(/\b(?:export\s+)?interface\s+Env\s*\{([\s\S]*?)\n?\}/)?.[1];
  if (!body) return [];

  return Array.from(body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/gm)).flatMap(
    (match) => {
      const name = match[1];
      const kind = workerEnvBindingKind(name, match[2]);
      return kind ? [{ name, kind, source: relativeWorkerConfigPath(repoPath, envPath) }] : [];
    },
  );
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
    if (typeof name === 'string' && name.trim()) {
      declarations.push({ name, kind, source: 'wrangler config' });
    }
  }
}

function workerJsonConfigBindingDeclarations(config: Record<string, unknown>): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];

  const ai = recordValue(config.ai);
  if (typeof ai?.binding === 'string' && ai.binding.trim()) {
    declarations.push({ name: ai.binding, kind: 'ai', source: 'wrangler config' });
  }

  const assets = recordValue(config.assets);
  if (typeof assets?.binding === 'string' && assets.binding.trim()) {
    declarations.push({ name: assets.binding, kind: 'assets', source: 'wrangler config' });
  }

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

export function workerJsonEnvironmentRecord(config: Record<string, unknown>, environmentName: string) {
  return recordValue(recordValue(config.env)?.[environmentName]);
}

function workerJsonHasEnvironment(config: Record<string, unknown>, environmentName: string) {
  return Boolean(workerJsonEnvironmentRecord(config, environmentName));
}

function pushTomlBindings(
  declarations: WorkerBindingDeclaration[],
  text: string,
  tableName: string,
  kind: WorkerBindingKind,
  key = 'binding',
) {
  for (const body of tomlArrayTableBodies(text, tableName)) {
    const name = firstTomlStringValue(body, key);
    if (name) declarations.push({ name, kind, source: 'wrangler config' });
  }
}

function workerTomlConfigBindingDeclarations(text: string): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];

  const aiBody = tomlSectionBody(text, 'ai');
  const aiBinding = aiBody ? firstTomlStringValue(aiBody, 'binding') : undefined;
  if (aiBinding) declarations.push({ name: aiBinding, kind: 'ai', source: 'wrangler config' });

  const assetsBody = tomlSectionBody(text, 'assets');
  const assetsBinding = assetsBody ? firstTomlStringValue(assetsBody, 'binding') : undefined;
  if (assetsBinding) declarations.push({ name: assetsBinding, kind: 'assets', source: 'wrangler config' });

  pushTomlBindings(declarations, text, 'd1_databases', 'd1');
  pushTomlBindings(declarations, text, 'durable_objects.bindings', 'durable_object', 'name');
  pushTomlBindings(declarations, text, 'hyperdrive', 'hyperdrive');
  pushTomlBindings(declarations, text, 'kv_namespaces', 'kv');
  pushTomlBindings(declarations, text, 'queues.producers', 'queue');
  pushTomlBindings(declarations, text, 'r2_buckets', 'r2');
  pushTomlBindings(declarations, text, 'services', 'service');
  pushTomlBindings(declarations, text, 'vectorize', 'vectorize');
  pushTomlBindings(declarations, text, 'workflows', 'workflow');

  return declarations;
}

function workerTomlEnvironmentBindingDeclarations(text: string, environmentName: string): WorkerBindingDeclaration[] {
  const declarations: WorkerBindingDeclaration[] = [];
  const prefix = `env.${environmentName}`;

  const aiBody = tomlSectionBody(text, `${prefix}.ai`);
  const aiBinding = aiBody === undefined ? undefined : firstTomlStringValue(aiBody, 'binding');
  if (aiBinding) declarations.push({ name: aiBinding, kind: 'ai', source: `env.${environmentName} Wrangler config` });

  const assetsBody = tomlSectionBody(text, `${prefix}.assets`);
  const assetsBinding = assetsBody === undefined ? undefined : firstTomlStringValue(assetsBody, 'binding');
  if (assetsBinding) {
    declarations.push({ name: assetsBinding, kind: 'assets', source: `env.${environmentName} Wrangler config` });
  }

  pushTomlBindings(declarations, text, `${prefix}.d1_databases`, 'd1');
  pushTomlBindings(declarations, text, `${prefix}.durable_objects.bindings`, 'durable_object', 'name');
  pushTomlBindings(declarations, text, `${prefix}.hyperdrive`, 'hyperdrive');
  pushTomlBindings(declarations, text, `${prefix}.kv_namespaces`, 'kv');
  pushTomlBindings(declarations, text, `${prefix}.queues.producers`, 'queue');
  pushTomlBindings(declarations, text, `${prefix}.r2_buckets`, 'r2');
  pushTomlBindings(declarations, text, `${prefix}.services`, 'service');
  pushTomlBindings(declarations, text, `${prefix}.vectorize`, 'vectorize');
  pushTomlBindings(declarations, text, `${prefix}.workflows`, 'workflow');

  return declarations;
}

function workerConfigBindingDeclarations(repoPath: string): WorkerBindingDeclaration[] {
  const configPath = workerConfigPath(repoPath);
  if (!configPath) return [];

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return workerTomlConfigBindingDeclarations(text);

  const config = parseWranglerJsonConfig(text);
  return config ? workerJsonConfigBindingDeclarations(config) : [];
}

export function workerEnvBindingAlignmentGaps(repoPath: string) {
  const envBindings = workerEnvBindingDeclarations(repoPath);
  if (!envBindings.length || !workerConfigPath(repoPath)) return [];

  const configBindings = workerConfigBindingDeclarations(repoPath);
  const configKeySet = new Set(configBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const envKeySet = new Set(envBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const gaps: string[] = [];

  for (const binding of envBindings) {
    if (configKeySet.has(`${binding.kind}:${binding.name}`)) continue;
    gaps.push(
      `${binding.source} declares ${binding.name} as a ${binding.kind} binding, but Wrangler config has no matching ${binding.kind} binding named "${binding.name}". Use identical binding names across Env and Wrangler config.`,
    );
  }

  for (const binding of configBindings) {
    if (envKeySet.has(`${binding.kind}:${binding.name}`)) continue;
    gaps.push(
      `Wrangler config declares ${binding.name} as a ${binding.kind} binding, but src/env.ts has no matching ${binding.kind} Env property named "${binding.name}". Use identical binding names across Env and Wrangler config.`,
    );
  }

  return gaps;
}

const workerDeploymentEnvironments = ['staging', 'production'] as const;

function workerEnvironmentMirrorGaps({
  environmentName,
  topLevelBindings,
  environmentBindings,
  topLevelVars,
  environmentVars,
}: {
  environmentName: string;
  topLevelBindings: WorkerBindingDeclaration[];
  environmentBindings: WorkerBindingDeclaration[];
  topLevelVars: string[];
  environmentVars: string[];
}) {
  const gaps: string[] = [];
  const environmentBindingKeys = new Set(environmentBindings.map((binding) => `${binding.kind}:${binding.name}`));
  const environmentVarSet = new Set(environmentVars);

  for (const binding of topLevelBindings) {
    if (environmentBindingKeys.has(`${binding.kind}:${binding.name}`)) continue;
    const article = /^[aeiou]/i.test(binding.kind) ? 'an' : 'a';
    gaps.push(
      `env.${environmentName} must declare ${binding.name} as ${article} ${binding.kind} binding because Wrangler bindings are non-inheritable across environments.`,
    );
  }

  for (const varName of topLevelVars) {
    if (environmentVarSet.has(varName)) continue;
    gaps.push(
      `env.${environmentName}.vars must declare ${varName} because Wrangler vars are non-inheritable across environments.`,
    );
  }

  return gaps;
}

function workerJsonDeploymentEnvironmentGaps(config: Record<string, unknown>) {
  const gaps: string[] = [];
  const topLevelBindings = workerJsonConfigBindingDeclarations(config);
  const topLevelVars = workerJsonConfigVarNames(config);

  for (const environmentName of workerDeploymentEnvironments) {
    const environment = workerJsonEnvironmentRecord(config, environmentName);
    if (!environment) {
      gaps.push(
        `env.${environmentName} is missing; define a Wrangler ${environmentName} environment so local validation, preview/staging, and human-approved production deploys have explicit targets.`,
      );
      continue;
    }

    gaps.push(
      ...workerEnvironmentMirrorGaps({
        environmentName,
        topLevelBindings,
        environmentBindings: workerJsonConfigBindingDeclarations(environment),
        topLevelVars,
        environmentVars: workerJsonConfigVarNames(environment),
      }),
    );
  }

  return gaps;
}

function workerTomlDeploymentEnvironmentGaps(text: string) {
  const gaps: string[] = [];
  const topLevelBindings = workerTomlConfigBindingDeclarations(text);
  const topLevelVars = tomlSectionKeyNames(text, 'vars');

  for (const environmentName of workerDeploymentEnvironments) {
    if (!tomlHasEnvironment(text, environmentName)) {
      gaps.push(
        `env.${environmentName} is missing; define a Wrangler ${environmentName} environment so local validation, preview/staging, and human-approved production deploys have explicit targets.`,
      );
      continue;
    }

    gaps.push(
      ...workerEnvironmentMirrorGaps({
        environmentName,
        topLevelBindings,
        environmentBindings: workerTomlEnvironmentBindingDeclarations(text, environmentName),
        topLevelVars,
        environmentVars: tomlSectionKeyNames(text, `env.${environmentName}.vars`),
      }),
    );
  }

  return gaps;
}

export function workerConfigHasEnvironment(repoPath: string, environmentName: string) {
  const configPath = workerConfigPath(repoPath);
  if (!configPath) return false;

  const text = readFileSync(configPath, 'utf8');
  if (configPath.endsWith('.toml')) return tomlHasEnvironment(text, environmentName);

  const config = parseWranglerJsonConfig(text);
  return config ? workerJsonHasEnvironment(config, environmentName) : false;
}

function directoryHasNonIgnoredFiles(directory: string): boolean {
  if (!existsSync(directory)) return false;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directoryHasNonIgnoredFiles(entryPath)) return true;
      continue;
    }
    if (entry.isFile()) return true;
  }

  return false;
}

function repoHasPublicStaticAssets(repoPath: string) {
  return directoryHasNonIgnoredFiles(join(resolve(repoPath), 'public'));
}

function assetDirectoryIsPublic(value: unknown) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '');
  return normalized === 'public';
}

function workerStaticAssetsGaps(repoPath: string, assetsConfig: Record<string, unknown> | undefined) {
  if (!repoHasPublicStaticAssets(repoPath)) return [];
  if (!assetsConfig) {
    return [
      'assets is missing; public/ UI files must be deployed through Workers Static Assets with assets.directory="./public" and binding="ASSETS".',
    ];
  }

  const gaps: string[] = [];
  if (!assetDirectoryIsPublic(assetsConfig.directory)) {
    gaps.push('assets.directory must be "./public" so Wrangler uploads the vanilla public/ UI with the Worker.');
  }
  if (assetsConfig.binding !== 'ASSETS') {
    gaps.push('assets.binding must be "ASSETS" so Worker code can fall back to env.ASSETS.fetch(request) when needed.');
  }

  return gaps;
}

export function workerConfigHygieneGaps(repoPath: string, task?: Task, guards: WorkerHygieneTaskGuards = {}) {
  const canConfigureWorkerConfig = guards.taskCanConfigureWorkerConfig ?? taskCanConfigureWorkerConfigFallback;
  if (task && !canConfigureWorkerConfig(repoPath, task)) return [];

  const configPath = workerConfigPath(repoPath);
  if (!configPath) {
    if (task) return ['Worker config surface is owned, but no Wrangler config file exists.'];
    return repoLooksLikeWorkerProject(repoPath)
      ? ['No Wrangler config file exists for this Worker project; add wrangler.jsonc with Worker entrypoint, compatibility_date, bindings, and observability before release.']
      : [];
  }

  const configName = relativeWorkerConfigPath(repoPath, configPath);
  const text = readFileSync(configPath, 'utf8');
  const gaps: string[] = [];

  if (configPath.endsWith('.toml')) {
    gaps.push(...workerNameGaps(firstTomlStringValue(text, 'name')));
    gaps.push(...workerMainEntrypointGaps(repoPath, firstTomlStringValue(text, 'main')));
    gaps.push(...workerCompatibilityDateGaps(firstTomlStringValue(text, 'compatibility_date')));
    if (!tomlArrayStringValues(text, 'compatibility_flags').includes('nodejs_compat')) {
      gaps.push('compatibility_flags must include "nodejs_compat" so Wrangler provides Node.js compatibility for npm packages.');
    }

    const observability = tomlSectionBody(text, 'observability');
    if (!observability) {
      gaps.push('observability is missing; add [observability] with enabled=true and head_sampling_rate.');
    } else {
      gaps.push(
        ...observabilityConfigGaps({
          enabled: firstTomlBooleanValue(observability, 'enabled'),
          head_sampling_rate: firstTomlNumberValue(observability, 'head_sampling_rate'),
        }),
      );
    }

    const assets = tomlSectionBody(text, 'assets');
    gaps.push(
      ...workerStaticAssetsGaps(
        repoPath,
        assets
          ? {
              directory: firstTomlStringValue(assets, 'directory'),
              binding: firstTomlStringValue(assets, 'binding'),
            }
          : undefined,
      ),
    );
    gaps.push(...workerTomlDeploymentEnvironmentGaps(text));
    gaps.push(...workerEnvBindingAlignmentGaps(repoPath));

    return gaps.map((gap) => `${configName}: ${gap}`);
  }

  const config = parseWranglerJsonConfig(text);
  if (!config) return [`${configName}: config is not valid JSONC that can be parsed for Worker config hygiene.`];

  if (config.$schema !== './node_modules/wrangler/config-schema.json') {
    gaps.push('$schema must be "./node_modules/wrangler/config-schema.json" so Wrangler/editor validation resolves locally.');
  }

  gaps.push(...workerNameGaps(config.name));
  gaps.push(...workerMainEntrypointGaps(repoPath, config.main));
  gaps.push(...workerCompatibilityDateGaps(config.compatibility_date));

  if (!stringArrayValue(config.compatibility_flags).includes('nodejs_compat')) {
    gaps.push('compatibility_flags must include "nodejs_compat" so Wrangler provides Node.js compatibility for npm packages.');
  }

  gaps.push(...observabilityConfigGaps(recordValue(config.observability)));
  gaps.push(...workerStaticAssetsGaps(repoPath, recordValue(config.assets)));
  gaps.push(...workerJsonDeploymentEnvironmentGaps(config));
  gaps.push(...workerEnvBindingAlignmentGaps(repoPath));

  return gaps.map((gap) => `${configName}: ${gap}`);
}

function packageNodeModulesPath(root: string, name: string) {
  const parts = name.startsWith('@') ? name.split('/') : [name];
  return join(root, 'node_modules', ...parts);
}

export function missingInstalledPackageNames(repoPath: string) {
  const root = resolve(repoPath);
  if (!existsSync(join(root, 'node_modules'))) return packageDependencyNames(repoPath);

  return packageDependencyNames(repoPath).filter((name) => !existsSync(packageNodeModulesPath(root, name)));
}

function packageRecord(repoPath: string) {
  return recordValue(readJsonArtifact(repoPath, 'package.json'));
}

function packageDependencyVersion(packageJson: Record<string, unknown>, name: string) {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const bucket = recordValue(packageJson[key]);
    const version = bucket?.[name];
    if (typeof version === 'string') return version;
  }
  return undefined;
}

function dependencyRangeMajor(version: string) {
  const match = /(?:^|[^\d])(\d+)(?:\.\d+)?/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

function dependencyRangeAllowsWranglerV4(version: string) {
  const normalized = version.trim().toLowerCase();
  if (normalized === 'latest') return true;
  const major = dependencyRangeMajor(normalized);
  return major !== undefined && major >= 4;
}

function wranglerScriptCommandTail(script: unknown, command: 'dev' | 'deploy') {
  if (typeof script !== 'string') return undefined;
  const match = new RegExp(`\\bwrangler\\s+${command}\\b([^;&|\\n]*)`).exec(script);
  return match ? (match[1] ?? '') : undefined;
}

function commandTailUsesEnvironment(commandTail: string, environmentName: string) {
  const escaped = environmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:--env(?:=|\\s+)|-e(?:=|\\s+))${escaped}(?:\\s|$)`).test(commandTail);
}

function commandTailHasEntrypoint(commandTail: string) {
  return /(^|\s)(?:\.\/)?(?:(?:src|workers)\/\S+\.(?:js|mjs|cjs|ts|tsx|mts|cts)|worker\.(?:js|mjs|cjs|ts|tsx|mts|cts))(\s|$)/.test(
    commandTail,
  );
}

function scriptUsesWranglerEnvironmentWithoutEntrypoint(
  script: unknown,
  command: 'dev' | 'deploy',
  environmentName: string,
) {
  const commandTail = wranglerScriptCommandTail(script, command);
  return (
    commandTail !== undefined &&
    !commandTailHasEntrypoint(commandTail) &&
    commandTailUsesEnvironment(commandTail, environmentName)
  );
}

function scriptRunsWranglerTypes(script: unknown) {
  return typeof script === 'string' && /\bwrangler\s+types\b/.test(script);
}

function scriptRunsTypecheckWithGeneratedWorkerTypes(script: unknown) {
  if (typeof script !== 'string') return false;
  const runsTypeScript = /\btsc\s+--noEmit\b/.test(script);
  const generatesTypes = /\bwrangler\s+types\b/.test(script) || /\bnpm\s+run\s+(?:generate-types|typegen|cf-typegen)\b/.test(script);
  return runsTypeScript && generatesTypes;
}

const forbiddenFrontendPackageNames = [
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
];

function frontendFrameworkDependencyGaps(repoPath: string) {
  const dependencies = new Set(packageDependencyNames(repoPath));
  const forbidden = forbiddenFrontendPackageNames.filter((name) => dependencies.has(name));
  return forbidden.length
    ? [
        `package.json: remove frontend framework/build dependencies (${forbidden.join(', ')}); Chris's Worker projects use vanilla HTML, CSS, and JavaScript without React, Vite, Next, Vue, or Svelte.`,
      ]
    : [];
}

function frontendBuildScriptGaps(scripts: Record<string, unknown>) {
  const buildScript = scripts.build;
  if (typeof buildScript !== 'string') return [];
  if (!/\b(vite|next|react-scripts|webpack|rollup|parcel|astro|svelte-kit)\b/i.test(buildScript)) return [];

  return [
    `package.json: scripts.build uses a frontend framework/bundler command ("${buildScript}"); Worker projects should validate with tests/Wrangler, add tsc only for TypeScript source, and serve vanilla public assets without a frontend build step.`,
  ];
}

function tsconfigWorkerScaffoldGaps(repoPath: string) {
  const tsconfigPath = join(resolve(repoPath), 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return ['tsconfig.json: missing; TypeScript Worker scaffolds need a Worker-runtime TypeScript config for deterministic typecheck.'];
  }

  const config = parseWranglerJsonConfig(readFileSync(tsconfigPath, 'utf8'));
  if (!config) return ['tsconfig.json: file is not valid JSONC.'];

  const compilerOptions = recordValue(config.compilerOptions);
  if (!compilerOptions) return ['tsconfig.json: compilerOptions is missing.'];

  const gaps: string[] = [];
  const target = typeof compilerOptions.target === 'string' ? compilerOptions.target.toLowerCase() : '';
  if (!/^es(?:202[2-9]|next)$/.test(target)) {
    gaps.push('tsconfig.json: compilerOptions.target should be ES2022 or newer for Cloudflare Workers.');
  }

  const module = typeof compilerOptions.module === 'string' ? compilerOptions.module.toLowerCase() : '';
  if (module !== 'esnext') {
    gaps.push('tsconfig.json: compilerOptions.module should be ESNext for Worker module syntax.');
  }

  const moduleResolution =
    typeof compilerOptions.moduleResolution === 'string' ? compilerOptions.moduleResolution.toLowerCase() : '';
  if (moduleResolution !== 'bundler') {
    gaps.push('tsconfig.json: compilerOptions.moduleResolution should be Bundler for Wrangler/Worker imports.');
  }

  const libs = stringArrayValue(compilerOptions.lib).map((item) => item.toLowerCase());
  if (!libs.some((item) => /^es(?:202[2-9]|next)$/.test(item))) {
    gaps.push('tsconfig.json: compilerOptions.lib should include ES2022 or newer.');
  }
  if (!libs.includes('webworker')) {
    gaps.push('tsconfig.json: compilerOptions.lib should include WebWorker for Cloudflare Worker globals.');
  }

  const includes = stringArrayValue(config.include).map((item) => item.toLowerCase());
  if (!includes.includes('./worker-configuration.d.ts') && !includes.includes('worker-configuration.d.ts')) {
    gaps.push('tsconfig.json: include should contain worker-configuration.d.ts generated by wrangler types.');
  }

  const types = stringArrayValue(compilerOptions.types).map((item) => item.toLowerCase());
  if (!types.includes('node')) {
    gaps.push('tsconfig.json: compilerOptions.types should include node when nodejs_compat is enabled.');
  }

  if (compilerOptions.strict !== true) {
    gaps.push('tsconfig.json: compilerOptions.strict should be true.');
  }

  return gaps;
}

function directoryContainsTypeScriptWorkerSource(directory: string): boolean {
  if (!existsSync(directory)) return false;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['.delivery', '.git', '.wrangler', 'node_modules'].includes(entry.name)) continue;
      if (directoryContainsTypeScriptWorkerSource(entryPath)) return true;
      continue;
    }

    if (entry.isFile() && workerSourceSurfaceIsTypeScript(entry.name)) return true;
  }

  return false;
}

export function repoUsesTypeScriptWorkerSource(repoPath: string, task?: Task) {
  const root = resolve(repoPath);
  return (
    (task !== undefined && taskOwnsTypeScriptWorkerSourceFallback(task)) ||
    existsSync(join(root, 'tsconfig.json')) ||
    directoryContainsTypeScriptWorkerSource(join(root, 'src')) ||
    directoryContainsTypeScriptWorkerSource(join(root, 'workers')) ||
    existsSync(join(root, 'worker.ts')) ||
    existsSync(join(root, 'worker.mts')) ||
    existsSync(join(root, 'worker.cts'))
  );
}

const workerScaffoldRequiredGitignorePatterns = ['node_modules/', '.wrangler/', '.delivery/', '.dev.vars*', '.env*', '*.cpuprofile'];

function gitignorePatternPresent(text: string, pattern: string) {
  const directoryPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const patterns = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (pattern === '.dev.vars*' && patterns.includes('.dev.vars') && patterns.includes('.dev.vars.*')) return true;
  if (pattern === '.env*' && patterns.includes('.env') && patterns.includes('.env.*')) return true;

  return patterns.some((line) => line === pattern || line === directoryPattern);
}

function workerScaffoldGitignoreGaps(repoPath: string) {
  const gitignorePath = join(resolve(repoPath), '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [
      '.gitignore is missing; new Worker scaffolds must keep local delivery artifacts, Wrangler state, startup profiles, dependencies, and local secrets out of git.',
    ];
  }

  const text = readFileSync(gitignorePath, 'utf8');
  const missing = workerScaffoldRequiredGitignorePatterns.filter((pattern) => !gitignorePatternPresent(text, pattern));
  return missing.length
    ? [
        `.gitignore should ignore ${missing.join(', ')} so generated delivery state, local Wrangler state, startup profiles, dependencies, and local secrets stay out of git.`,
      ]
    : [];
}

export function workerPackageScaffoldGaps(repoPath: string, task?: Task, guards: WorkerHygieneTaskGuards = {}) {
  const ownsPackageManifest = guards.taskOwnsPackageManifest ?? taskOwnsPackageManifestFallback;
  if (task && !ownsPackageManifest(task)) return [];

  const packageJson = packageRecord(repoPath);
  if (!packageJson) {
    if (task) return ['package.json is owned but is not valid JSON.'];
    return repoLooksLikeWorkerProject(repoPath)
      ? ['package.json is missing; Worker release requires local package scripts and a local Wrangler devDependency.']
      : [];
  }

  const usesTypeScript = (guards.repoUsesTypeScriptWorkerSource ?? repoUsesTypeScriptWorkerSource)(repoPath, task);
  const gaps: string[] = [];
  const scripts = recordValue(packageJson.scripts) ?? {};
  if (!scriptUsesWranglerEnvironmentWithoutEntrypoint(scripts.dev, 'dev', 'staging')) {
    gaps.push(
      'package.json: scripts.dev should run "wrangler dev --env staging" through wrangler.jsonc, without passing a Worker source entrypoint argument.',
    );
  }
  if (!scriptUsesWranglerEnvironmentWithoutEntrypoint(scripts.deploy, 'deploy', 'production')) {
    gaps.push(
      'package.json: scripts.deploy should run "wrangler deploy --env production" through wrangler.jsonc, without passing a Worker source entrypoint argument.',
    );
  }
  if (usesTypeScript && !scriptRunsWranglerTypes(scripts['generate-types'])) {
    gaps.push(
      'package.json: scripts.generate-types should run "wrangler types" to generate worker-configuration.d.ts from Wrangler config.',
    );
  }
  if (usesTypeScript && !scriptRunsTypecheckWithGeneratedWorkerTypes(scripts.typecheck)) {
    gaps.push(
      'package.json: scripts.typecheck should run "npm run generate-types && tsc --noEmit" for deterministic Worker binding types.',
    );
  }
  gaps.push(...frontendBuildScriptGaps(scripts));

  const wranglerVersion = packageDependencyVersion(packageJson, 'wrangler');
  if (!wranglerVersion) {
    gaps.push('package.json: devDependencies.wrangler is missing; new Worker scaffolds need Wrangler installed locally.');
  } else if (!dependencyRangeAllowsWranglerV4(wranglerVersion)) {
    gaps.push(`package.json: devDependencies.wrangler is "${wranglerVersion}", but new Worker scaffolds should use pinned/current Wrangler v4+ tooling.`);
  }

  if (usesTypeScript) {
    const nodeTypesVersion = packageDependencyVersion(packageJson, '@types/node');
    if (!nodeTypesVersion) {
      gaps.push(
        'package.json: devDependencies["@types/node"] is missing; nodejs_compat Worker TypeScript projects need Node.js type declarations for generated Wrangler types.',
      );
    }
  }

  return [
    ...gaps,
    ...frontendFrameworkDependencyGaps(repoPath),
    ...(usesTypeScript ? tsconfigWorkerScaffoldGaps(repoPath) : []),
    ...workerScaffoldGitignoreGaps(repoPath),
  ];
}

function d1DatabaseNameFromRecord(record: Record<string, unknown> | undefined) {
  if (!record) return undefined;
  const databaseName = record.database_name;
  const databaseId = record.database_id;
  const binding = record.binding;
  if (typeof databaseName === 'string' && databaseName.trim()) return databaseName;
  if (typeof databaseId === 'string' && databaseId.trim()) return databaseId;
  if (typeof binding === 'string' && binding.trim()) return binding;
  return undefined;
}

export function workerJsonD1DatabaseName(config: Record<string, unknown> | undefined) {
  if (!config) return undefined;
  const d1Databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  for (const database of d1Databases) {
    const databaseName = d1DatabaseNameFromRecord(recordValue(database));
    if (databaseName) return databaseName;
  }

  return undefined;
}

export function workerTomlD1DatabaseName(text: string, environmentName?: string) {
  const tableName = environmentName ? `env.${environmentName}.d1_databases` : 'd1_databases';
  for (const body of tomlArrayTableBodies(text, tableName)) {
    const databaseName = d1DatabaseNameFromRecord({
      database_name: firstTomlStringValue(body, 'database_name'),
      database_id: firstTomlStringValue(body, 'database_id'),
      binding: firstTomlStringValue(body, 'binding'),
    });
    if (databaseName) return databaseName;
  }

  return undefined;
}
