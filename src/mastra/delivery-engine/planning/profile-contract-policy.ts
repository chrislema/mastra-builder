import { taskCanSafelyDependOn, taskDependsOn } from '../task-plan-dependencies';
import { taskOwnsAnyExactSurface, taskOwnsD1MigrationFile } from '../task-plan-surface-policy';
import type { TaskPlan } from '../workflow-schemas';

export const profileContractProducerSurfaces = [
  'src/validation.ts',
  'src/contracts.ts',
  'src/domain.ts',
  'src/domain/profileKinds.ts',
  'src/domain/profile.ts',
  'src/domain/profiles.ts',
  'src/domain/profileArtifacts.ts',
];

const profileContractConsumerSurfaces = ['migrations/0001_schema.sql', 'src/storage/profiles.ts', 'src/routes/profiles.ts'];

function profileContractProducerTask(taskPlan: TaskPlan) {
  return taskPlan.tasks.find((task) => taskOwnsAnyExactSurface(task, profileContractProducerSurfaces));
}

function profileContractConsumerTasks(taskPlan: TaskPlan) {
  return taskPlan.tasks.filter(
    (task) => taskOwnsAnyExactSurface(task, profileContractConsumerSurfaces) || taskOwnsD1MigrationFile(task),
  );
}

export function normalizeTaskPlanProfileContractDependencies(taskPlan: TaskPlan): TaskPlan {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return taskPlan;

  let changed = false;
  const tasks = taskPlan.tasks.map((task) => {
    if (!profileContractConsumerTasks(taskPlan).some((consumer) => consumer.id === task.id)) return task;
    if (taskDependsOn(taskPlan, task.id, producer.id)) return task;
    if (!taskCanSafelyDependOn(taskPlan, task.id, producer.id)) return task;

    changed = true;
    return {
      ...task,
      depends_on: [...task.depends_on, producer.id],
    };
  });

  return changed ? { ...taskPlan, tasks } : taskPlan;
}

export function profileContractDependencyHygiene(taskPlan: TaskPlan) {
  const producer = profileContractProducerTask(taskPlan);
  if (!producer) return { passed: true, reason: 'ok' };

  for (const task of profileContractConsumerTasks(taskPlan)) {
    if (taskDependsOn(taskPlan, task.id, producer.id)) continue;
    return {
      passed: false,
      reason: `${task.id} owns a profile contract consumer surface but does not depend_on ${producer.id}. Schema, storage, and profile routes must run after the validation/domain contract so profile kind values stay aligned.`,
    };
  }

  return { passed: true, reason: 'ok' };
}
