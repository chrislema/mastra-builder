import type { ProjectLanguage, ProjectProfile, TestRuntimeKind, TestRuntimeRule } from './schemas';

const nodeIncludes = [
  'test/contracts.test.{ts,js}',
  'test/validation.test.{ts,js}',
  'test/domain.test.{ts,js}',
  'test/**/*.node.test.{ts,js}',
];

const workerIncludes = [
  'test/api-routes.test.{ts,js}',
  'test/provider-adapters.test.{ts,js}',
  'test/worker-smoke.test.{ts,js}',
  'test/**/*.worker.test.{ts,js}',
];

const frontendIncludes = ['test/frontend-*.test.{ts,js}', 'test/ui-*.test.{ts,js}'];

export function classifyTestRuntime(path: string): TestRuntimeKind {
  const normalized = path.replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1) ?? normalized;

  if (/^(frontend|ui)-.+\.test\.[cm]?[jt]s$/.test(basename)) return 'jsdom';
  if (/\.(?:worker)\.test\.[cm]?[jt]s$/.test(basename)) return 'worker';
  if (/^(api-routes|provider-adapters|worker-smoke)\.test\.[cm]?[jt]s$/.test(basename)) return 'worker';
  if (/\.(?:node)\.test\.[cm]?[jt]s$/.test(basename)) return 'node';
  if (/^(contracts|validation|domain)\.test\.[cm]?[jt]s$/.test(basename)) return 'node';

  return 'node';
}

export function testRuntimeMatrixForProfiles(_profiles: ProjectProfile[]): TestRuntimeRule[] {
  return [
    { name: 'node', runtime: 'node', include: nodeIncludes },
    { name: 'worker', runtime: 'worker', include: workerIncludes },
    { name: 'frontend', runtime: 'jsdom', include: frontendIncludes },
  ];
}

function quoteArray(values: string[]) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

export function renderVitestConfig(language: ProjectLanguage) {
  const extension = language === 'typescript' ? 'ts' : 'js';

  return [
    "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';",
    "import { defineConfig, defineProject } from 'vitest/config';",
    '',
    'export default defineConfig({',
    '  test: {',
    '    passWithNoTests: true,',
    '    projects: [',
    '      defineProject({',
    '        test: {',
    "          name: 'node',",
    "          environment: 'node',",
    `          include: ${quoteArray(nodeIncludes.map((pattern) => pattern.replace('{ts,js}', extension)))},`,
    '          passWithNoTests: true,',
    '        },',
    '      }),',
    '      defineProject({',
    '        plugins: [',
    '          cloudflareTest({',
    '            wrangler: {',
    "              configPath: './wrangler.jsonc',",
    "              environment: 'staging',",
    '            },',
    '          }),',
    '        ],',
    '        test: {',
    "          name: 'worker',",
    `          include: ${quoteArray(workerIncludes.map((pattern) => pattern.replace('{ts,js}', extension)))},`,
    '          passWithNoTests: true,',
    '        },',
    '      }),',
    '      defineProject({',
    '        test: {',
    "          name: 'frontend',",
    "          environment: 'jsdom',",
    `          include: ${quoteArray(frontendIncludes.map((pattern) => pattern.replace('{ts,js}', extension)))},`,
    '          passWithNoTests: true,',
    '        },',
    '      }),',
    '    ],',
    '  },',
    '});',
    '',
  ].join('\n');
}
