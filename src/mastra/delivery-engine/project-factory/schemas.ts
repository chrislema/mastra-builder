import { z } from 'zod';

export const projectProfileSchema = z.enum([
  'worker-vanilla-js',
  'worker-typescript',
  'worker-d1',
  'worker-kv',
  'worker-r2',
  'worker-workers-ai',
  'worker-workflows',
  'worker-authenticated-admin',
  'pages-explicit',
]);

export const projectLanguageSchema = z.enum(['javascript', 'typescript']);

export const scaffoldSurfaceKindSchema = z.enum([
  'config',
  'contract',
  'frontend',
  'metadata',
  'migration',
  'test',
  'worker',
]);

export const testRuntimeKindSchema = z.enum(['node', 'worker', 'jsdom', 'wrangler']);

export const sourceDocumentSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const projectFactorySourcePolicySchema = z.object({
  pagesRequired: z.boolean().default(false),
  requiredProfileKinds: z.array(z.string()).default([]),
  latestTranscriptRequired: z.boolean().default(false),
  shortLinkLifecycleRequired: z.boolean().default(false),
  externalServiceBindings: z.array(z.string()).default([]),
});

export const projectFactoryInputSchema = z.object({
  projectName: z.string().min(1).default('worker-app'),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-07-01'),
  language: projectLanguageSchema.optional(),
  requestedProfiles: z.array(projectProfileSchema).default([]),
  sourceDocuments: z.array(sourceDocumentSchema).default([]),
  sourcePolicy: projectFactorySourcePolicySchema.default({
    pagesRequired: false,
    requiredProfileKinds: [],
    latestTranscriptRequired: false,
    shortLinkLifecycleRequired: false,
    externalServiceBindings: [],
  }),
});

export const generatedScaffoldFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  surfaceKind: scaffoldSurfaceKindSchema,
  ownedByFactory: z.boolean().default(true),
});

export const testRuntimeRuleSchema = z.object({
  name: z.string().min(1),
  runtime: testRuntimeKindSchema,
  include: z.array(z.string().min(1)),
});

export const scaffoldManifestSchema = z.object({
  profileList: z.array(projectProfileSchema),
  language: projectLanguageSchema,
  main: z.string().min(1),
  generatedFiles: z.array(z.string().min(1)),
  generatedFileSurfaces: z.record(z.string().min(1), scaffoldSurfaceKindSchema).default({}),
  testRuntimeMatrix: z.array(testRuntimeRuleSchema),
  bindingMap: z.record(z.string(), z.string()),
  packageScripts: z.record(z.string(), z.string()),
  validationCommands: z.array(z.string().min(1)),
});

export const projectScaffoldSchema = z.object({
  manifest: scaffoldManifestSchema,
  files: z.array(generatedScaffoldFileSchema),
});

export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export type ProjectLanguage = z.infer<typeof projectLanguageSchema>;
export type ScaffoldSurfaceKind = z.infer<typeof scaffoldSurfaceKindSchema>;
export type TestRuntimeKind = z.infer<typeof testRuntimeKindSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export type ProjectFactorySourcePolicy = z.infer<typeof projectFactorySourcePolicySchema>;
export type ProjectFactoryInput = z.input<typeof projectFactoryInputSchema>;
export type NormalizedProjectFactoryInput = z.output<typeof projectFactoryInputSchema>;
export type GeneratedScaffoldFile = z.infer<typeof generatedScaffoldFileSchema>;
export type TestRuntimeRule = z.infer<typeof testRuntimeRuleSchema>;
export type ScaffoldManifest = z.infer<typeof scaffoldManifestSchema>;
export type ProjectScaffold = z.infer<typeof projectScaffoldSchema>;
