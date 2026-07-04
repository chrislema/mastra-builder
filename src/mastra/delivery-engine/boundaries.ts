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
      'functions/_middleware.js',
      'functions/api/_middleware.js',
      'functions/api/*.js',
      'workers/*.js',
      'src/utils/*.js',
      'wrangler.toml',
      '**/*.sql',
    ],
    forbidden: ['public/**', 'tests/**'],
  },
  designer: {
    maxTurns: 40,
    owned: ['public/*.html', 'public/*.css', 'public/*.js', 'public/assets/**'],
    forbidden: ['functions/**', 'workers/**', 'src/**', 'tests/**', 'wrangler.toml'],
  },
  tester: {
    maxTurns: 40,
    owned: ['tests/**'],
    forbidden: ['functions/**', 'workers/**', 'public/**', 'src/**'],
  },
  deployer: {
    maxTurns: 20,
    owned: [],
    forbidden: ['**'],
  },
} as const;

export type DeliveryRole = keyof typeof roleBoundaries;

export const deliveryRoles = Object.keys(roleBoundaries) as DeliveryRole[];
