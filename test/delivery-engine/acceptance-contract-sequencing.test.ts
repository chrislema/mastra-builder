import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeTaskPlanCloudflareWorkerContracts,
  taskDeferredAcceptanceContractCriteria,
  taskVerificationAcceptanceContractCriteria,
} from '../../src/mastra/delivery-engine/planning/cloudflare-worker-contracts-policy.ts';
import type { TaskPlan } from '../../src/mastra/delivery-engine/workflow-schemas.ts';

const structuralModelFields =
  'Contract definitions include model fields id, label, vendor, provider, model, optional secretKey, and optional baseUrl.';
const structuralRunRequest =
  'Run request contract accepts models as an array of model IDs, a required userPrompt string, and an optional systemPrompt string.';
const crossLayerProviderIds =
  'Provider contracts support workers-ai, anthropic, and openai-compatible provider identifiers without duplicating string literals across route and adapter code.';
const validationBehavior =
  'Validation helpers or schemas make empty model lists and blank userPrompt distinguishable as 400-level client errors.';
const providerFailureBehavior =
  'Contracts define provider failure normalization rules so external provider non-OK responses become provider_error results with vendor, status when available, and a bounded client-safe message.';
const frontendBehavior =
  'Contracts define the frontend single-model request expectation: each browser request may send models containing exactly one selected model ID, while the API contract still accepts arrays for resilient batch handling.';

function taskPlan(tasks: TaskPlan['tasks']): TaskPlan {
  return {
    artifact_type: 'task-plan',
    scope: 'Benchmark app',
    tasks,
    technology_decisions: [],
    open_decisions: [],
    risks: [],
  };
}

test('source contract tasks keep immediate structural ACs and defer downstream behavior ACs', () => {
  const normalized = normalizeTaskPlanCloudflareWorkerContracts(
    taskPlan([
      {
        id: 'T01',
        owner: 'engineer',
        deliverable:
          'Define shared Benchmark contracts for model catalog entries, run requests, provider output, validation result shapes, and frontend request behavior.',
        depends_on: [],
        acceptance_criteria: [
          structuralModelFields,
          structuralRunRequest,
          crossLayerProviderIds,
          validationBehavior,
          providerFailureBehavior,
          frontendBehavior,
        ],
        owned_surfaces: ['src/contracts.ts'],
      },
    ]),
  );
  const sourceTask = normalized.tasks.find((task) => task.id === 'T01');
  const evidenceTask = normalized.tasks.find((task) => task.id === 'T01-contract-behavior-tests');

  assert.ok(sourceTask);
  assert.ok(evidenceTask);

  const immediate = taskVerificationAcceptanceContractCriteria(sourceTask, normalized);
  const deferred = taskDeferredAcceptanceContractCriteria(normalized, sourceTask);

  assert.deepEqual(immediate, [structuralModelFields, structuralRunRequest]);
  assert.deepEqual(deferred, [crossLayerProviderIds, validationBehavior, providerFailureBehavior, frontendBehavior]);
  assert.match((evidenceTask.source_acceptance_criteria ?? []).join('\n'), /provider_error results/);
});

test('evidence tasks still receive their own mandatory test contracts', () => {
  const normalized = normalizeTaskPlanCloudflareWorkerContracts(
    taskPlan([
      {
        id: 'T01',
        owner: 'engineer',
        deliverable: 'Define shared contracts and validation behavior.',
        depends_on: [],
        acceptance_criteria: [structuralModelFields, validationBehavior],
        owned_surfaces: ['src/contracts.ts'],
      },
    ]),
  );
  const evidenceTask = normalized.tasks.find((task) => task.id === 'T01-contract-behavior-tests');

  assert.ok(evidenceTask);
  assert.deepEqual(taskDeferredAcceptanceContractCriteria(normalized, evidenceTask), []);
  assert.match(
    taskVerificationAcceptanceContractCriteria(evidenceTask, normalized).join('\n'),
    /test\/contracts\.test\.ts imports the source contract or validation helpers directly/,
  );
});

test('task verification criteria stay backward-compatible when no plan context is supplied', () => {
  const [sourceTask] = taskPlan([
    {
      id: 'T01',
      owner: 'engineer',
      deliverable: 'Define shared contracts and validation behavior.',
      depends_on: [],
      acceptance_criteria: [structuralModelFields, validationBehavior],
      owned_surfaces: ['src/contracts.ts'],
    },
  ]).tasks;

  assert.deepEqual(taskVerificationAcceptanceContractCriteria(sourceTask), [structuralModelFields, validationBehavior]);
});
