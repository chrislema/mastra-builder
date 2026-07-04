export const roleBoundaries = {
  planner: {
    maxTurns: 30,
    owned: [],
    forbidden: ['**'],
  },
  architect: {
    maxTurns: 30,
    owned: [],
    forbidden: ['**'],
  },
  engineer: {
    maxTurns: 40,
    owned: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'tsconfig*.json',
      '*.config.*',
      'vite.config.*',
      'next.config.*',
      'functions/_middleware.js',
      'functions/api/_middleware.js',
      'functions/**',
      'workers/**',
      'src/**',
      'app/**',
      'lib/**',
      'server/**',
      'api/**',
      'scripts/**',
      'db/**',
      'prisma/**',
      'wrangler.toml',
      '**/*.sql',
    ],
    forbidden: ['public/**', 'tests/**'],
  },
  designer: {
    maxTurns: 40,
    owned: ['public/**', 'src/**', 'app/**', 'pages/**', 'components/**', 'styles/**', 'assets/**'],
    forbidden: [
      'functions/**',
      'workers/**',
      'server/**',
      'api/**',
      'src/api/**',
      'src/server/**',
      'src/lib/server/**',
      'db/**',
      'prisma/**',
      'tests/**',
      'wrangler.toml',
      '**/*.sql',
    ],
  },
  tester: {
    maxTurns: 40,
    owned: ['tests/**', 'test/**', 'e2e/**', 'playwright.config.*', 'vitest.config.*'],
    forbidden: ['functions/**', 'workers/**', 'public/**', 'src/**', 'app/**', 'server/**', 'api/**'],
  },
  deployer: {
    maxTurns: 20,
    owned: [],
    forbidden: ['**'],
  },
  judge: {
    maxTurns: 20,
    owned: [],
    forbidden: ['**'],
  },
} as const;

export type DeliveryRole = keyof typeof roleBoundaries;

export const deliveryRoles = Object.keys(roleBoundaries) as DeliveryRole[];
