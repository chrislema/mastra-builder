import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSuspendForPlannerQuestions } from '../../src/mastra/delivery-engine/workflow.ts';

const readout = (blocking_ambiguities: string[]) => ({
  artifact_type: 'readout' as const,
  product_intent: 'intent',
  technical_shape: 'shape',
  safe_assumptions: [],
  blocking_ambiguities,
  recommended_next_step: 'next',
});

const taskPlan = (tasks: Array<{ depends_on: string[]; acceptance_criteria?: string[]; owned_surfaces?: string[] }>) => ({
  artifact_type: 'task-plan' as const,
  scope: 'scope',
  tasks: tasks.map((task, index) => ({
    id: `T${index + 1}`,
    owner: 'engineer' as const,
    deliverable: 'deliverable',
    depends_on: task.depends_on,
    acceptance_criteria: task.acceptance_criteria ?? ['verified'],
    owned_surfaces: task.owned_surfaces ?? ['src/index.ts'],
  })),
  technology_decisions: [],
  open_decisions: [],
  risks: [],
});

test('planner questions are deferred when a task plan has an executable root task', () => {
  assert.equal(
    shouldSuspendForPlannerQuestions(readout(['Confirm downstream integration detail.']), taskPlan([{ depends_on: [] }])),
    false,
  );
});

test('planner questions suspend when no executable root task exists', () => {
  assert.equal(shouldSuspendForPlannerQuestions(readout(['Cannot start safely.']), taskPlan([])), true);
});
