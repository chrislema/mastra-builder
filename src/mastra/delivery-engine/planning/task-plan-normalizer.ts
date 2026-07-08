import { sourcePolicyFromRepo } from '../source-policy';
import { annotateTaskPlanWithTypedMetadata } from '../task-plan-metadata';
import type { TaskPlan } from '../workflow-schemas';
import { normalizeTaskPlanCloudflareWorkerContracts } from './cloudflare-worker-contracts-policy';
import { normalizeTaskPlanConfigSchemaTasks } from './config-schema-policy';
import { normalizeTaskPlanGeneratedSliceDependencies } from './generated-slice-policy';
import { normalizeTaskPlanLargeStorageTasks } from './large-task-policy';
import { normalizeTaskPlanOperatorDocumentation } from './operator-documentation-policy';
import { normalizeTaskPlanProfileContractDependencies } from './profile-contract-policy';
import { normalizeTaskPlanRoleBoundaries } from './role-boundary-policy';
import { normalizeTaskPlanScaffoldDependencies } from './scaffold-policy';

export function normalizeTaskPlanForDelivery(repoPath: string, taskPlan: TaskPlan): TaskPlan {
  const sourcePolicy = sourcePolicyFromRepo(repoPath);
  return annotateTaskPlanWithTypedMetadata(
    normalizeTaskPlanOperatorDocumentation(
      normalizeTaskPlanCloudflareWorkerContracts(
        normalizeTaskPlanGeneratedSliceDependencies(
          normalizeTaskPlanLargeStorageTasks(
            normalizeTaskPlanConfigSchemaTasks(
              normalizeTaskPlanRoleBoundaries(
                normalizeTaskPlanProfileContractDependencies(normalizeTaskPlanScaffoldDependencies(repoPath, taskPlan)),
              ),
            ),
          ),
        ),
        sourcePolicy,
      ),
    ),
  );
}
