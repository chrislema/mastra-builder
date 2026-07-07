import { resolve } from 'node:path';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { deliveryWorkflowRunAsyncResponseSchema, startDeliveryWorkflowRunAsync } from './runner';

export const deliveryStartInputSchema = z.object({
  projectFolder: z
    .string()
    .trim()
    .min(1)
    .describe('Project folder containing vision.md. This is the only required field for a new delivery run.'),
});

export const deliveryStartOutputSchema = deliveryWorkflowRunAsyncResponseSchema.extend({
  projectFolder: z.string(),
  nextSteps: z.array(z.string()),
});

const launchDeliveryWorkflowStep = createStep({
  id: 'launch-delivery-workflow',
  description: 'Launch the full Delivery Engine workflow from a single project folder path.',
  inputSchema: deliveryStartInputSchema,
  outputSchema: deliveryStartOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const projectFolder = resolve(inputData.projectFolder);
    const response = await startDeliveryWorkflowRunAsync(mastra as any, {
      projectFolder,
    });

    return {
      ...response,
      projectFolder,
      nextSteps: [
        'Open the delivery-workflow run in Studio or Observability to watch the full delivery engine.',
        `Inspect ${projectFolder}/.delivery/run.json for the local run projection once initialization starts.`,
      ],
    };
  },
});

export const deliveryStartWorkflow = createWorkflow({
  id: 'delivery-start',
  description: 'Start here: provide one project folder path and launch the Cloudflare Worker delivery engine.',
  inputSchema: deliveryStartInputSchema,
  outputSchema: deliveryStartOutputSchema,
})
  .then(launchDeliveryWorkflowStep)
  .commit();
