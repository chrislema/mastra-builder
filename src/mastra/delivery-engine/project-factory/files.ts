import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { languageForProfiles, normalizeProjectFactoryInput, normalizeProjectName, selectProjectProfiles } from './profiles';
import { packageScriptsForLanguage, renderPackageJson } from './package-manifest';
import { renderVitestConfig, testRuntimeMatrixForProfiles } from './test-runtime-matrix';
import { bindingMapForProfiles, renderWranglerConfig } from './wrangler-config';
import {
  type GeneratedScaffoldFile,
  type NormalizedProjectFactoryInput,
  type ProjectLanguage,
  type ProjectProfile,
  type ProjectScaffold,
  projectScaffoldSchema,
} from './schemas';

function scaffoldFile(path: string, content: string, surfaceKind: GeneratedScaffoldFile['surfaceKind']): GeneratedScaffoldFile {
  return { path, content, surfaceKind, ownedByFactory: true };
}

function hasProfile(profiles: ProjectProfile[], profile: ProjectProfile) {
  return profiles.includes(profile);
}

function sourceExtension(language: ProjectLanguage) {
  return language === 'typescript' ? 'ts' : 'js';
}

function renderGitignore() {
  return ['node_modules/', '.wrangler/', '.dev.vars', 'worker-configuration.d.ts', 'dist/', 'coverage/', ''].join('\n');
}

function renderDevVarsExample(profiles: ProjectProfile[]) {
  const lines = ['# Copy to .dev.vars for local-only secrets.'];
  if (hasProfile(profiles, 'worker-authenticated-admin')) lines.push('ADMIN_SESSION_SECRET=change-me-locally');
  return `${lines.join('\n')}\n`;
}

function renderTsConfig() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'Bundler',
        lib: ['ES2022'],
        types: ['node'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
      },
      include: ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts', 'worker-configuration.d.ts'],
    },
    null,
    2,
  )}\n`;
}

function renderContracts(language: ProjectLanguage) {
  if (language === 'typescript') {
    return [
      "export const ERROR_CODES = ['bad_request', 'not_found', 'provider_error', 'timeout_or_network_error'] as const;",
      'export type ErrorCode = (typeof ERROR_CODES)[number];',
      '',
      'export interface ApiErrorBody {',
      '  error: ErrorCode;',
      '  message: string;',
      '  details?: unknown;',
      '}',
      '',
      'export const CLIENT_SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {',
      "  bad_request: 'The request could not be processed.',",
      "  not_found: 'The requested resource was not found.',",
      "  provider_error: 'The upstream provider could not complete the request.',",
      "  timeout_or_network_error: 'The upstream provider timed out or could not be reached.',",
      '};',
      '',
      'export function apiError(error: ErrorCode, details?: unknown): ApiErrorBody {',
      '  return { error, message: CLIENT_SAFE_ERROR_MESSAGES[error], ...(details === undefined ? {} : { details }) };',
      '}',
      '',
      'export function jsonResponse<T>(body: T, init: ResponseInit = {}) {',
      '  return Response.json(body, { headers: { "content-type": "application/json; charset=utf-8" }, ...init });',
      '}',
      '',
      'export function errorResponse(error: ErrorCode, status = 400, details?: unknown) {',
      '  return jsonResponse(apiError(error, details), { status });',
      '}',
      '',
    ].join('\n');
  }

  return [
    "export const ERROR_CODES = ['bad_request', 'not_found', 'provider_error', 'timeout_or_network_error'];",
    '',
    'export const CLIENT_SAFE_ERROR_MESSAGES = {',
    "  bad_request: 'The request could not be processed.',",
    "  not_found: 'The requested resource was not found.',",
    "  provider_error: 'The upstream provider could not complete the request.',",
    "  timeout_or_network_error: 'The upstream provider timed out or could not be reached.',",
    '};',
    '',
    'export function apiError(error, details) {',
    '  return { error, message: CLIENT_SAFE_ERROR_MESSAGES[error], ...(details === undefined ? {} : { details }) };',
    '}',
    '',
    'export function jsonResponse(body, init = {}) {',
    '  return Response.json(body, { headers: { "content-type": "application/json; charset=utf-8" }, ...init });',
    '}',
    '',
    'export function errorResponse(error, status = 400, details) {',
    '  return jsonResponse(apiError(error, details), { status });',
    '}',
    '',
  ].join('\n');
}

function renderEnvInterface(profiles: ProjectProfile[], externalServiceBindings: string[]) {
  const fields = ['  ASSETS: Fetcher;'];
  if (hasProfile(profiles, 'worker-workers-ai')) fields.push('  AI: Ai;');
  if (hasProfile(profiles, 'worker-d1')) fields.push('  DB: D1Database;');
  if (hasProfile(profiles, 'worker-kv')) fields.push('  KV: KVNamespace;');
  if (hasProfile(profiles, 'worker-r2')) fields.push('  ARTIFACTS: R2Bucket;');
  if (hasProfile(profiles, 'worker-workflows')) fields.push('  PROCESSING_WORKFLOW: Workflow;');
  for (const binding of externalServiceBindings) fields.push(`  ${binding}: Fetcher;`);
  return ['export interface Env {', ...fields, '}'].join('\n');
}

function renderBindingStatus(profiles: ProjectProfile[], externalServiceBindings: string[]) {
  const lines = ["    assets: Boolean(env.ASSETS),"];
  if (hasProfile(profiles, 'worker-workers-ai')) lines.push('    ai: Boolean(env.AI),');
  if (hasProfile(profiles, 'worker-d1')) lines.push('    d1: Boolean(env.DB),');
  if (hasProfile(profiles, 'worker-kv')) lines.push('    kv: Boolean(env.KV),');
  if (hasProfile(profiles, 'worker-r2')) lines.push('    r2: Boolean(env.ARTIFACTS),');
  if (hasProfile(profiles, 'worker-workflows')) lines.push('    workflow: Boolean(env.PROCESSING_WORKFLOW),');
  for (const binding of externalServiceBindings) lines.push(`    ${binding.toLowerCase()}: Boolean(env.${binding}),`);
  return lines;
}

function renderWorkerSource(language: ProjectLanguage, profiles: ProjectProfile[], externalServiceBindings: string[]) {
  const importPath = language === 'typescript' ? './contracts' : './contracts.js';
  const workflowImport = hasProfile(profiles, 'worker-workflows')
    ? ["import { WorkflowEntrypoint } from 'cloudflare:workers';"]
    : [];
  const envInterface = language === 'typescript' ? [renderEnvInterface(profiles, externalServiceBindings), ''] : [];
  const satisfies = language === 'typescript' ? ' satisfies ExportedHandler<Env>' : '';
  const envParameter = language === 'typescript' ? 'env: Env' : 'env';
  const ctxParameter = language === 'typescript' ? '_ctx: ExecutionContext' : '_ctx';
  const requestParameter = language === 'typescript' ? 'request: Request' : 'request';
  const aiRoute = hasProfile(profiles, 'worker-workers-ai')
    ? [
        '',
        "    if (url.pathname === '/api/ai' && request.method === 'POST') {",
        '      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt: "Return a short health message." });',
        '      return jsonResponse({ ok: true, result });',
        '    }',
      ]
    : [];
  const workflowExport = hasProfile(profiles, 'worker-workflows')
    ? [
        '',
        language === 'typescript'
          ? 'export class ProcessingWorkflow extends WorkflowEntrypoint<Env, { id?: string }> {'
          : 'export class ProcessingWorkflow extends WorkflowEntrypoint {',
        '  async run() {',
        '    return { ok: true };',
        '  }',
        '}',
      ]
    : [];

  return [
    ...workflowImport,
    `import { errorResponse, jsonResponse } from '${importPath}';`,
    '',
    ...envInterface,
    language === 'typescript' ? 'function bindingStatus(env: Env) {' : 'function bindingStatus(env) {',
    '  return {',
    ...renderBindingStatus(profiles, externalServiceBindings),
    '  };',
    '}',
    '',
    'export default {',
    `  async fetch(${requestParameter}, ${envParameter}, ${ctxParameter}) {`,
    '    const url = new URL(request.url);',
    '',
    "    if (url.pathname === '/api/health') {",
    "      return jsonResponse({ ok: true, service: 'worker-app', bindings: bindingStatus(env) });",
    '    }',
    ...aiRoute,
    '',
    '    if (env.ASSETS) {',
    '      return env.ASSETS.fetch(request);',
    '    }',
    '',
    "    return errorResponse('not_found', 404);",
    '  },',
    `}${satisfies};`,
    ...workflowExport,
    '',
  ].join('\n');
}

function renderPublicIndex(projectName: string) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${projectName}</title>`,
    '  <link rel="stylesheet" href="/styles.css">',
    '</head>',
    '<body>',
    '  <main class="app-shell">',
    `    <h1>${projectName}</h1>`,
    '    <p data-status>Ready.</p>',
    '    <button type="button" data-health-check>Check Worker</button>',
    '    <pre data-health-result></pre>',
    '  </main>',
    '  <script type="module" src="/app.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function renderPublicStyles() {
  return [
    ':root {',
    '  color-scheme: light;',
    '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  line-height: 1.5;',
    '  color: #17202a;',
    '  background: #f7f9fb;',
    '}',
    '',
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-items: center;',
    '}',
    '',
    '.app-shell {',
    '  width: min(720px, calc(100vw - 32px));',
    '  display: grid;',
    '  gap: 16px;',
    '}',
    '',
    'button {',
    '  width: fit-content;',
    '  min-height: 40px;',
    '  padding: 0 14px;',
    '}',
    '',
    'pre {',
    '  min-height: 96px;',
    '  padding: 12px;',
    '  overflow: auto;',
    '  background: #101820;',
    '  color: #f7f9fb;',
    '}',
    '',
  ].join('\n');
}

function renderPublicApp() {
  return [
    "const button = document.querySelector('[data-health-check]');",
    "const status = document.querySelector('[data-status]');",
    "const result = document.querySelector('[data-health-result]');",
    '',
    "button?.addEventListener('click', async () => {",
    "  status.textContent = 'Checking Worker...';",
    "  result.textContent = '';",
    '  const response = await fetch("/api/health");',
    '  const body = await response.json();',
    '  status.textContent = response.ok ? "Worker is healthy." : "Worker check failed."; ',
    '  result.textContent = JSON.stringify(body, null, 2);',
    '});',
    '',
  ].join('\n');
}

function renderContractsTest(language: ProjectLanguage) {
  const importPath = language === 'typescript' ? '../src/contracts' : '../src/contracts.js';
  return [
    "import { describe, expect, it } from 'vitest';",
    `import { CLIENT_SAFE_ERROR_MESSAGES, ERROR_CODES, apiError } from '${importPath}';`,
    '',
    "describe('shared API contracts', () => {",
    "  it('keeps client-safe errors centralized', () => {",
    "    expect(ERROR_CODES).toContain('provider_error');",
    "    expect(ERROR_CODES).toContain('timeout_or_network_error');",
    '    expect(apiError("not_found")).toEqual({',
    "      error: 'not_found',",
    "      message: CLIENT_SAFE_ERROR_MESSAGES.not_found,",
    '    });',
    '  });',
    '});',
    '',
  ].join('\n');
}

function renderWorkerSmokeTest(language: ProjectLanguage) {
  const importPath = language === 'typescript' ? '../src/index' : '../src/index.js';
  const castEnv = language === 'typescript' ? ' as any' : '';
  const castCtx = language === 'typescript' ? ' as any' : '';
  return [
    "import { describe, expect, it } from 'vitest';",
    `import worker from '${importPath}';`,
    '',
    "describe('Worker smoke route', () => {",
    "  it('returns health details from the Worker runtime', async () => {",
    "    const request = new Request('https://example.com/api/health');",
    `    const response = await worker.fetch(request, { ASSETS: { fetch: async () => new Response('asset') } }${castEnv}, {}${castCtx});`,
    '    expect(response.status).toBe(200);',
    '    await expect(response.json()).resolves.toMatchObject({ ok: true });',
    '  });',
    '});',
    '',
  ].join('\n');
}

function renderFrontendTest() {
  return [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { describe, expect, it } from 'vitest';",
    '',
    "describe('vanilla frontend shell', () => {",
    "  it('ships a health-check control without React or a bundler shell', () => {",
    "    document.body.innerHTML = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8');",
    "    expect(document.querySelector('[data-health-check]')).toBeTruthy();",
    "    expect(document.querySelector('[data-health-result]')).toBeTruthy();",
    '  });',
    '});',
    '',
  ].join('\n');
}

function renderD1Migration() {
  return [
    'CREATE TABLE IF NOT EXISTS app_events (',
    '  id TEXT PRIMARY KEY,',
    '  type TEXT NOT NULL,',
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ');',
    '',
  ].join('\n');
}

function renderReadme(projectName: string, profiles: ProjectProfile[]) {
  return [
    `# ${projectName}`,
    '',
    'Cloudflare Worker application generated by the Mastra delivery scaffold factory.',
    '',
    `Profiles: ${profiles.join(', ')}`,
    '',
    '- `npm run dev` starts Wrangler locally with the staging environment.',
    '- `npm run deploy` deploys with the production environment after human approval.',
    '- `npm test` runs Node, Worker, and vanilla frontend test projects.',
    '',
  ].join('\n');
}

function validationCommands(language: ProjectLanguage) {
  return language === 'typescript' ? ['npm run typecheck', 'npm test'] : ['npm test'];
}

export function renderProjectScaffold(input: unknown): ProjectScaffold {
  const normalized: NormalizedProjectFactoryInput = normalizeProjectFactoryInput(input);
  const profiles = selectProjectProfiles(normalized);
  const language = languageForProfiles(profiles);
  const extension = sourceExtension(language);
  const projectName = normalizeProjectName(normalized.projectName);
  const main = `src/index.${extension}`;
  const externalServiceBindings = normalized.sourcePolicy.externalServiceBindings;
  const files: GeneratedScaffoldFile[] = [
    scaffoldFile('package.json', renderPackageJson(projectName, language), 'metadata'),
    scaffoldFile('wrangler.jsonc', renderWranglerConfig({ projectName, main, compatibilityDate: normalized.compatibilityDate, profiles, externalServiceBindings }), 'config'),
    scaffoldFile('.gitignore', renderGitignore(), 'metadata'),
    scaffoldFile('.dev.vars.example', renderDevVarsExample(profiles), 'metadata'),
    scaffoldFile('vitest.config.ts', renderVitestConfig(language), 'config'),
    scaffoldFile(`src/contracts.${extension}`, renderContracts(language), 'contract'),
    scaffoldFile(main, renderWorkerSource(language, profiles, externalServiceBindings), 'worker'),
    scaffoldFile('public/index.html', renderPublicIndex(projectName), 'frontend'),
    scaffoldFile('public/styles.css', renderPublicStyles(), 'frontend'),
    scaffoldFile('public/app.js', renderPublicApp(), 'frontend'),
    scaffoldFile(`test/contracts.test.${extension}`, renderContractsTest(language), 'test'),
    scaffoldFile(`test/worker-smoke.test.${extension}`, renderWorkerSmokeTest(language), 'test'),
    scaffoldFile('test/frontend-shell.test.js', renderFrontendTest(), 'test'),
    scaffoldFile('README.md', renderReadme(projectName, profiles), 'metadata'),
  ];

  if (language === 'typescript') files.splice(5, 0, scaffoldFile('tsconfig.json', renderTsConfig(), 'config'));
  if (hasProfile(profiles, 'worker-d1')) files.push(scaffoldFile('migrations/0001_app_events.sql', renderD1Migration(), 'migration'));

  const manifest = {
    profileList: profiles,
    language,
    main,
    generatedFiles: files.map((file) => file.path),
    testRuntimeMatrix: testRuntimeMatrixForProfiles(profiles),
    bindingMap: bindingMapForProfiles(profiles),
    packageScripts: packageScriptsForLanguage(language),
    validationCommands: validationCommands(language),
  };

  return projectScaffoldSchema.parse({ manifest, files });
}

export function materializeProjectScaffold(projectFolder: string, scaffold: ProjectScaffold) {
  for (const file of scaffold.files) {
    const fullPath = join(projectFolder, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }
}
