import type { DeliveryWorkflowState } from '../workflow-schemas';

export function scaffoldStageFields(input: Partial<DeliveryWorkflowState>) {
  return {
    ...(input.scaffoldManifest ? { scaffoldManifest: input.scaffoldManifest } : {}),
    ...(input.scaffoldManifestPath ? { scaffoldManifestPath: input.scaffoldManifestPath } : {}),
  };
}
