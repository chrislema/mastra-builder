
import { Mastra } from '@mastra/core/mastra';
import { ConsoleLogger } from '@mastra/core/logger';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { deliveryAgents, deliveryMemory } from './delivery-engine/agents';
import { deliveryProcessors } from './delivery-engine/processors';
import { deliveryApiRoutes } from './delivery-engine/routes';
import { deliveryScorers } from './delivery-engine/scorers';
import { deliveryStateTools } from './delivery-engine/tools';
import {
  deliveryMastraObservabilityServiceName,
  deliveryMastraStorageId,
  ensureLocalMastraStorageDirectory,
  getDeliveryMastraStorageUrl,
} from './config';
import {
  deliveryBuildTaskWorkflow,
  deliveryBuildWorkflow,
  deliveryDeploymentWorkflow,
  deliveryPlanningWorkflow,
  deliveryReleaseGateWorkflow,
  deliveryReviewWorkflow,
  deliveryWorkflow,
} from './delivery-engine/workflow';
import { deliveryWorkspace } from './delivery-engine/workspace';

export {
  cloudflareArchitectureDatasetItems,
  cloudflareArchitectureDatasetName,
  cloudflareArchitectureScorerIds,
  ensureCloudflareArchitectureDataset,
  runCloudflareArchitectureExperiment,
} from './delivery-engine/cloudflare-evals';

export {
  deliveryRegressionDatasetItems,
  deliveryRegressionDatasetName,
  deliveryRegressionScorerIds,
  ensureDeliveryRegressionDataset,
  runDeliveryRegressionExperiment,
} from './delivery-engine/evals';

const deliveryMastraStorageUrl = getDeliveryMastraStorageUrl();
ensureLocalMastraStorageDirectory(deliveryMastraStorageUrl);

export const mastra = new Mastra({
  workflows: {
    deliveryWorkflow,
    deliveryPlanningWorkflow,
    deliveryReviewWorkflow,
    deliveryBuildWorkflow,
    deliveryBuildTaskWorkflow,
    deliveryReleaseGateWorkflow,
    deliveryDeploymentWorkflow,
  },
  agents: deliveryAgents,
  memory: { deliveryMemory },
  processors: deliveryProcessors,
  scorers: deliveryScorers,
  tools: deliveryStateTools,
  workspace: deliveryWorkspace,
  storage: new LibSQLStore({
    id: deliveryMastraStorageId,
    url: deliveryMastraStorageUrl,
  }),
  logger: new ConsoleLogger({
    name: 'Builders Delivery Engine',
    level: 'info',
  }),
  server: {
    apiRoutes: deliveryApiRoutes,
  },
  observability: new Observability({
    configs: {
      default: {
        serviceName: deliveryMastraObservabilityServiceName,
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_PLATFORM_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
