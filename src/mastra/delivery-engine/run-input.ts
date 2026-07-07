import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const blankStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

export const optionalNonEmptyStringSchema = z.preprocess(blankStringToUndefined, z.string().min(1).optional());

const requiredNonEmptyStringSchema = z.string().trim().min(1);

const defaultedNonEmptyStringSchema = (fallback: string) =>
  z.preprocess(blankStringToUndefined, z.string().min(1).default(fallback));

const defaultedNonNegativeIntegerSchema = (fallback: number) =>
  z.preprocess(blankStringToUndefined, z.coerce.number().int().min(0).default(fallback));

export const deliveryDeployModeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['local', 'mock', 'preview'].includes(normalized)) return 'local';
  if (['production', 'prod', 'real'].includes(normalized)) return 'production';
  return value;
}, z.enum(['local', 'production']).default('local'));

const deliveryReviewModeSchema = z.preprocess(
  blankStringToUndefined,
  z.enum(['fast', 'thorough']).default('thorough'),
);

const deliveryWorkflowSharedInputShape = {
  visionPath: defaultedNonEmptyStringSchema('vision.md').describe(
    'Path to the vision document inside the project folder. Defaults to vision.md.',
  ),
  specPath: optionalNonEmptyStringSchema.describe(
    'Optional path to the spec document inside the project folder. If omitted, spec.md is used only when it exists.',
  ),
  maxRetries: defaultedNonNegativeIntegerSchema(2).describe('Bounded retry count. Defaults to 2.'),
  deployMode: deliveryDeployModeSchema.describe('local/production target. mock/real remain supported aliases. Defaults to local.'),
  reviewMode: deliveryReviewModeSchema.describe('fast or thorough review. Defaults to thorough.'),
};

const deliveryWorkflowInputShape = {
  projectFolder: optionalNonEmptyStringSchema.describe(
    'Project folder to build in. This can be a new folder with vision.md; it does not need to already be a Git repo.',
  ),
  repoPath: optionalNonEmptyStringSchema.describe(
    'Compatibility alias for projectFolder. Existing API/CLI callers may keep using repoPath.',
  ),
  ...deliveryWorkflowSharedInputShape,
};

const deliveryWorkflowStudioInputShape = {
  projectFolder: requiredNonEmptyStringSchema.describe(
    'Required project folder to build in. This can be a new folder with vision.md; it does not need to already be a Git repo.',
  ),
  repoPath: optionalNonEmptyStringSchema.describe(
    'Compatibility alias for projectFolder. Leave blank in Studio unless an existing API caller still sends repoPath.',
  ),
  ...deliveryWorkflowSharedInputShape,
};

export const deliveryWorkflowInputBaseSchema = z.object(deliveryWorkflowInputShape);

function projectFolderIssue(input: { projectFolder?: string; repoPath?: string }) {
  if (!input.projectFolder && !input.repoPath) {
    return {
      code: z.ZodIssueCode.custom,
      path: ['projectFolder'],
      message: 'Project folder is required. Use projectFolder, or repoPath for compatibility.',
    };
  }

  if (input.projectFolder && input.repoPath && resolve(input.projectFolder) !== resolve(input.repoPath)) {
    return {
      code: z.ZodIssueCode.custom,
      path: ['repoPath'],
      message: 'projectFolder and repoPath must refer to the same folder when both are provided.',
    };
  }

  return undefined;
}

const deliveryWorkflowCompatibilityInputSchema = deliveryWorkflowInputBaseSchema.superRefine((input, ctx) => {
  const issue = projectFolderIssue(input);
  if (issue) ctx.addIssue(issue);
});

export const deliveryWorkflowInputSchema = z.object(deliveryWorkflowStudioInputShape).superRefine((input, ctx) => {
  const issue = projectFolderIssue(input);
  if (issue) ctx.addIssue(issue);
});

export const deliveryWorkflowNormalizedInputSchema = z.object({
  repoPath: z.string().min(1).describe('Resolved project folder path used internally as requestContext.repoPath.'),
  visionPath: z.string().min(1),
  specPath: z.string().min(1).optional(),
  maxRetries: z.number().int().min(0),
  deployMode: z.enum(['local', 'production']),
  reviewMode: z.enum(['fast', 'thorough']),
});

export type DeliveryWorkflowInputOptions = z.output<typeof deliveryWorkflowInputBaseSchema>;
export type NormalizedDeliveryWorkflowInput = z.output<typeof deliveryWorkflowNormalizedInputSchema>;

export function normalizeDeliveryWorkflowInput(
  input: unknown,
  { inferSpecPath = true }: { inferSpecPath?: boolean } = {},
): NormalizedDeliveryWorkflowInput {
  const parsed = deliveryWorkflowCompatibilityInputSchema.parse(input);
  const projectFolder = parsed.projectFolder ?? parsed.repoPath;
  if (!projectFolder) throw new Error('Project folder is required. Use projectFolder, or repoPath for compatibility.');

  if (parsed.projectFolder && parsed.repoPath && resolve(parsed.projectFolder) !== resolve(parsed.repoPath)) {
    throw new Error('projectFolder and repoPath must refer to the same folder when both are provided.');
  }

  const repoPath = resolve(projectFolder);
  const specPath = parsed.specPath ?? (inferSpecPath && existsSync(join(repoPath, 'spec.md')) ? 'spec.md' : undefined);

  return deliveryWorkflowNormalizedInputSchema.parse({
    repoPath,
    visionPath: parsed.visionPath,
    specPath,
    maxRetries: parsed.maxRetries,
    deployMode: parsed.deployMode,
    reviewMode: parsed.reviewMode,
  });
}
