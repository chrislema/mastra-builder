import { dependencyGraphAcyclic, planSchemaComplete } from '../checks';
import type { DeterministicGateResult } from '../judgment';
import type { SourcePolicy, TaskPlan } from '../workflow-schemas';
import { configSchemaTaskSplitHygiene } from './config-schema-policy';
import { generatedSliceDependencyHygiene } from './generated-slice-policy';
import { openDecisionHygiene } from './readout-policy';
import { operatorDocumentationHygiene } from './operator-documentation-policy';
import { ownedSurfaceHygiene } from './owned-surface-policy';
import { pagesFunctionsExceptionHygiene } from './pages-policy';
import { profileContractDependencyHygiene } from './profile-contract-policy';
import { routeBoundaryConsistencyHygiene } from './route-boundary-policy';
import { projectScaffoldHygiene } from './scaffold-policy';
import { taskOwnedSurfaceRoleHygiene } from './role-boundary-policy';

export function taskPlanDeterministicResults({
  repoPath,
  taskPlan,
  sourcePolicy,
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  sourcePolicy?: SourcePolicy;
}): DeterministicGateResult[] {
  return [
    { id: 'tasks_structurally_complete', check: 'plan_schema_complete', ...planSchemaComplete(taskPlan) },
    { id: 'no_circular_dependencies', check: 'dependency_graph_acyclic', ...dependencyGraphAcyclic(taskPlan) },
    { id: 'open_decisions_hygiene', check: 'open_decision_hygiene', ...openDecisionHygiene(taskPlan) },
    { id: 'owned_surfaces_concrete', check: 'owned_surface_hygiene', ...ownedSurfaceHygiene(taskPlan) },
    { id: 'owned_surfaces_match_roles', check: 'task_owned_surfaces_in_role_boundary', ...taskOwnedSurfaceRoleHygiene(taskPlan) },
    { id: 'pages_functions_source_declared', check: 'pages_functions_exception', ...pagesFunctionsExceptionHygiene(taskPlan, sourcePolicy) },
    { id: 'root_project_scaffolded', check: 'project_scaffold_hygiene', ...projectScaffoldHygiene(repoPath, taskPlan) },
    { id: 'config_schema_tasks_split', check: 'config_schema_task_split_hygiene', ...configSchemaTaskSplitHygiene(taskPlan) },
    { id: 'operator_documentation_planned', check: 'operator_documentation_hygiene', ...operatorDocumentationHygiene(taskPlan) },
    {
      id: 'generated_slice_dependencies_finalized',
      check: 'generated_slice_dependency_hygiene',
      ...generatedSliceDependencyHygiene(taskPlan),
    },
    {
      id: 'profile_contract_dependency_order',
      check: 'profile_contract_dependency_order',
      ...profileContractDependencyHygiene(taskPlan),
    },
    {
      id: 'route_boundary_consistent',
      check: 'route_boundary_consistency',
      ...routeBoundaryConsistencyHygiene(taskPlan),
    },
  ];
}
