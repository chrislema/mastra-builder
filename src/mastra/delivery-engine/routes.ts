import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import {
  deliveryWorkflowRunAsyncResponseSchema,
  deliveryWorkflowRunInputSchema,
  startDeliveryWorkflowRunAsync,
} from './runner';

const deliveryWorkflowRunErrorSchema = z.object({
  error: z.string(),
  issues: z.array(z.any()).optional(),
});

export const deliveryApiRoutes = [
  registerApiRoute('/delivery/run', {
    method: 'POST',
    openapi: {
      summary: 'Start a Delivery Engine workflow run',
      description:
        'Starts the registered delivery-workflow asynchronously with repoPath request context, resource scoping, and tracing metadata.',
      tags: ['Delivery Engine'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: deliveryWorkflowRunInputSchema,
          },
        },
      },
      responses: {
        202: {
          description: 'Delivery workflow run accepted and started asynchronously.',
          content: {
            'application/json': {
              schema: deliveryWorkflowRunAsyncResponseSchema,
            },
          },
        },
        400: {
          description: 'Invalid delivery workflow run request.',
          content: {
            'application/json': {
              schema: deliveryWorkflowRunErrorSchema,
            },
          },
        },
      },
    },
    handler: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const response = await startDeliveryWorkflowRunAsync(c.get('mastra') as any, body);
        return c.json(response, 202);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ error: 'invalid_delivery_workflow_run_request', issues: error.issues }, 400);
        }
        throw error;
      }
    },
  }),
];
