import { basename, resolve } from 'node:path';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { projectFactorySourcePolicySchema, scaffoldManifestSchema } from './project-factory/schemas';
import { materializeProjectScaffold, normalizeProjectName, renderProjectScaffold, validateMaterializedScaffold } from './project-factory';
import { sourceDocumentsFromRepo, sourcePolicyFromDocuments } from './source-policy';
import type { MastraLike } from './observability';
import { writeDeliveryArtifact } from './state';
import {
  appendDeliveryEventState,
  endDeliveryStageState,
  recordDeliveryArtifactState,
  startDeliveryStageState,
} from './state-service';
import { markDeliveryRunFailedOnWorkflowError } from './workflow-support/errors';

export const deliveryScaffoldInputSchema = z.object({
  repoPath: z.string().min(1),
  runId: z.string().optional(),
  projectName: z.string().min(1).optional(),
  sourcePolicy: projectFactorySourcePolicySchema.optional(),
});

export const deliveryScaffoldOutputSchema = z.object({
  repoPath: z.string(),
  runId: z.string().optional(),
  manifestPath: z.string(),
  scaffoldManifest: scaffoldManifestSchema,
  profileList: z.array(z.string()),
  generatedFiles: z.array(z.string()),
  bindingMap: z.record(z.string(), z.string()),
  validationCommands: z.array(z.string()),
  checks: z.array(z.object({ id: z.string(), check: z.string(), passed: z.boolean(), reason: z.string() })),
});

export type DeliveryScaffoldInput = z.input<typeof deliveryScaffoldInputSchema>;
export type DeliveryScaffoldOutput = z.output<typeof deliveryScaffoldOutputSchema>;

export async function executeDeliveryScaffold(input: DeliveryScaffoldInput, mastra?: MastraLike): Promise<DeliveryScaffoldOutput> {
  const parsed = deliveryScaffoldInputSchema.parse(input);
  const repoPath = resolve(parsed.repoPath);
  const sourceDocuments = sourceDocumentsFromRepo(repoPath);
  const sourcePolicy = parsed.sourcePolicy ?? sourcePolicyFromDocuments(sourceDocuments);
  if (sourcePolicy.pagesRequired) {
    throw new Error(
      [
        'Cloudflare Pages was explicitly requested by the source policy, but the deterministic delivery scaffold is Worker-only.',
        'Do not generate a standalone Worker scaffold for a Pages project until a dedicated Pages scaffold factory and runtime proof exist.',
      ].join(' '),
    );
  }
  const scaffold = renderProjectScaffold({
    projectName: parsed.projectName ?? normalizeProjectName(basename(repoPath)),
    sourceDocuments,
    sourcePolicy,
  });

  await startDeliveryStageState({
    repoPath,
    mastra,
    stage: 'scaffold',
    role: 'engineer',
    surfaces: scaffold.manifest.generatedFiles,
  });

  materializeProjectScaffold(repoPath, scaffold);
  const checks = validateMaterializedScaffold(repoPath, scaffold.manifest);

  const manifestPath = '.delivery/artifacts/scaffold-manifest.json';
  writeDeliveryArtifact({
    repoPath,
    artifactPath: manifestPath,
    artifact: scaffold.manifest,
  });
  await recordDeliveryArtifactState({
    repoPath,
    mastra,
    type: 'scaffold-manifest',
    path: manifestPath,
  });
  await appendDeliveryEventState({
    repoPath,
    mastra,
    event: {
      type: 'scaffold_generated',
      stage: 'scaffold',
      profiles: scaffold.manifest.profileList,
      generated_files: scaffold.manifest.generatedFiles,
      validation_commands: scaffold.manifest.validationCommands,
      checks,
    },
  });
  await endDeliveryStageState({
    repoPath,
    mastra,
    stage: 'scaffold',
    reason: 'complete_stage',
  });

  return deliveryScaffoldOutputSchema.parse({
    repoPath,
    runId: parsed.runId,
    manifestPath,
    scaffoldManifest: scaffold.manifest,
    profileList: scaffold.manifest.profileList,
    generatedFiles: scaffold.manifest.generatedFiles,
    bindingMap: scaffold.manifest.bindingMap,
    validationCommands: scaffold.manifest.validationCommands,
    checks,
  });
}

const createScaffoldManifestStep = createStep({
  id: 'create-scaffold-manifest',
  description: 'Generate deterministic Cloudflare Worker scaffold files and record the scaffold manifest artifact.',
  inputSchema: deliveryScaffoldInputSchema,
  outputSchema: deliveryScaffoldOutputSchema,
  execute: async ({ inputData, mastra }) => executeDeliveryScaffold(inputData, mastra as MastraLike),
});

export const deliveryScaffoldWorkflow = createWorkflow({
  id: 'delivery-scaffold',
  description: 'Deterministically scaffold a Cloudflare Worker project before implementation agents run.',
  inputSchema: deliveryScaffoldInputSchema,
  outputSchema: deliveryScaffoldOutputSchema,
  options: {
    onError: markDeliveryRunFailedOnWorkflowError,
  },
})
  .then(createScaffoldManifestStep)
  .commit();
