import {
  concreteOwnedSurfacePath,
  isWorkerConfigSurfacePath,
  taskOwnsD1MigrationFile,
  taskOwnsWorkerConfigFile,
} from '../task-plan-surface-policy';
import type { Task, TaskPlan } from '../workflow-schemas';
import { taskAcceptanceContractCriteria, taskSourceTaskId } from './task-contracts';

function criterionMentionsAny(criterion: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(criterion));
}

const workerConfigCriterionPatterns = [
  /\bwrangler(?:\.(?:jsonc|json|toml))?\b/i,
  /\bcompatibility_(?:date|flags?)\b/i,
  /\bnodejs_compat\b/i,
  /\bobservability\b/i,
  /\b(?:binding|bindings|vars|secrets?)\b/i,
  /\bWorkers AI\b/i,
];

const d1SchemaCriterionPatterns = [
  /\bmigrations?\b/i,
  /\bD1\b/i,
  /\bSQL\b/i,
  /\bschema\b/i,
  /\btables?\b/i,
  /\bindexes?\b/i,
];

function splitConfigSchemaAcceptanceCriteria(task: Task, kind: 'config' | 'schema') {
  const defaults =
    kind === 'config'
      ? [
          'Configure Wrangler separately from D1 schema migrations so bindings, compatibility, and observability can be validated without touching SQL.',
          'Keep Worker config aligned with current Worker policy: wrangler.jsonc for new projects, current compatibility_date, nodejs_compat, observability, and required bindings.',
        ]
      : [
          'Define D1 schema migrations separately from Worker config so SQL can be reviewed, applied, and repaired on its own.',
          'Keep migrations compatible with the Worker code and explicit D1 binding planned in Wrangler config.',
        ];
  const patterns = kind === 'config' ? workerConfigCriterionPatterns : d1SchemaCriterionPatterns;
  const matching = task.acceptance_criteria.filter((criterion) => criterionMentionsAny(criterion, patterns));
  return Array.from(new Set([...defaults, ...matching]));
}

function splitWorkerConfigAndD1SchemaTask(task: Task) {
  if (!taskOwnsWorkerConfigFile(task) || !taskOwnsD1MigrationFile(task)) return [task];

  const configSurfaces: string[] = [];
  const schemaSurfaces: string[] = [];
  const otherSurfaces: string[] = [];

  for (const surface of task.owned_surfaces) {
    const path = concreteOwnedSurfacePath(surface);
    if (path && isWorkerConfigSurfacePath(path)) {
      configSurfaces.push(surface);
    } else if (path && path.startsWith('migrations/') && path.endsWith('.sql')) {
      schemaSurfaces.push(surface);
    } else {
      otherSurfaces.push(surface);
    }
  }

  const schemaTaskId = `${task.id}-d1-schema`;
  const sourceTaskId = taskSourceTaskId(task);
  const sourceAcceptanceCriteria = taskAcceptanceContractCriteria(task);
  return [
    {
      ...task,
      deliverable: `${task.deliverable} (Worker configuration slice)`,
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'config'),
      owned_surfaces: [...configSurfaces, ...otherSurfaces],
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
    {
      ...task,
      id: schemaTaskId,
      deliverable: `${task.deliverable} (D1 schema slice)`,
      depends_on: [task.id],
      acceptance_criteria: splitConfigSchemaAcceptanceCriteria(task, 'schema'),
      owned_surfaces: schemaSurfaces,
      source_task_id: sourceTaskId,
      source_acceptance_criteria: sourceAcceptanceCriteria,
    },
  ];
}

export function normalizeTaskPlanConfigSchemaTasks(taskPlan: TaskPlan): TaskPlan {
  const expandedTasks: Task[] = [];
  const splitLastTaskId = new Map<string, string>();
  const splitTaskIds = new Set<string>();
  let changed = false;

  for (const task of taskPlan.tasks) {
    const slices = splitWorkerConfigAndD1SchemaTask(task);
    expandedTasks.push(...slices);
    if (slices.length > 1) {
      changed = true;
      splitLastTaskId.set(task.id, slices[slices.length - 1].id);
      for (const slice of slices) splitTaskIds.add(slice.id);
    }
  }

  if (!changed) return taskPlan;

  const tasks = expandedTasks.map((task) => {
    if (splitTaskIds.has(task.id)) return task;

    const depends_on = Array.from(new Set(task.depends_on.map((dependency) => splitLastTaskId.get(dependency) ?? dependency)));
    if (
      depends_on.length === task.depends_on.length &&
      depends_on.every((dependency, index) => dependency === task.depends_on[index])
    ) {
      return task;
    }

    return { ...task, depends_on };
  });

  return { ...taskPlan, tasks };
}

export function configSchemaTaskSplitHygiene(taskPlan: TaskPlan) {
  const combinedTask = taskPlan.tasks.find((task) => taskOwnsWorkerConfigFile(task) && taskOwnsD1MigrationFile(task));
  if (!combinedTask) return { passed: true, reason: 'ok' };

  return {
    passed: false,
    reason: `${combinedTask.id} owns both Wrangler config and D1 migration files. Split Worker config and migrations into separate engineer tasks so config hygiene, SQL review, and Wrangler validation can repair independently.`,
  };
}
