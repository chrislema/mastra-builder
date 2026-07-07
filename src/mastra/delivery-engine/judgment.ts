import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { DeterministicCheckName } from './checks';

export const judgeGateOutputSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  evidence: z.string().default(''),
});

export const judgeDimensionOutputSchema = z.object({
  id: z.string(),
  score: z.number().nullable(),
  evidence: z.string().default(''),
  not_scored_reason: z.string().optional(),
});

export const judgeOutputSchema = z.object({
  gates: z.array(judgeGateOutputSchema).default([]),
  dimensions: z.array(judgeDimensionOutputSchema).default([]),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export type RubricGate = {
  id: string;
  description?: string;
  severity?: string;
  on_fail?: string;
  cap_value?: number;
  check?: 'llm' | string | { deterministic?: DeterministicCheckName | string };
};

export type RubricDimension = {
  id: string;
  weight: number;
  description?: string;
  anchors?: Record<string, string>;
};

export type Rubric = {
  target?: {
    name?: string;
    type?: string;
  };
  evaluation_notes?: string[];
  scale: {
    min: number;
    max: number;
  };
  gates?: RubricGate[];
  dimensions?: RubricDimension[];
};

export type DeterministicGateResult = {
  id?: string;
  check?: string;
  passed: boolean;
  reason?: string;
};

export type AggregatedGate = {
  id: string;
  passed: boolean;
  evidence: string;
  source: 'deterministic' | 'llm' | 'missing';
};

export type AggregatedJudgment = {
  rubric: string;
  overall: number;
  overall_uncapped: number;
  threshold: number;
  passed: boolean;
  gates: AggregatedGate[];
  gates_failed: string[];
  dimensions_scored: Array<{
    id: string;
    score: number;
    weight: number;
    evidence: string;
  }>;
  dimensions_not_scored: Array<{
    id: string;
    reason: string;
  }>;
  dimensions_missing: string[];
  remediation: string[];
};

type JudgedDimension = {
  id: string;
  score: number | null;
  evidence: string;
  not_scored_reason?: string;
  weight: number;
};

const engineRoot = dirname(fileURLToPath(import.meta.url));
const deliveryEngineRootRelativeParts = ['src', 'mastra', 'delivery-engine'];

function deliveryEngineRootFromAncestor(seed: string) {
  let current = resolve(seed);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, ...deliveryEngineRootRelativeParts);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export function deliveryEngineAssetPath(...parts: string[]) {
  const explicitRoot = process.env.DELIVERY_ENGINE_ASSET_ROOT;
  const projectRoot = process.env.MASTRA_PROJECT_ROOT ?? process.env.SKILLS_BASE_DIR;
  const candidates = [
    explicitRoot ? resolve(explicitRoot) : undefined,
    projectRoot ? resolve(projectRoot, ...deliveryEngineRootRelativeParts) : undefined,
    deliveryEngineRootFromAncestor(process.cwd()),
    deliveryEngineRootFromAncestor(engineRoot),
    resolve(process.cwd(), ...deliveryEngineRootRelativeParts),
    engineRoot,
  ]
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, ...parts));

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? join(engineRoot, ...parts);
}

export function readJsonFile<T>(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadDeliveryEngineRubric(name: string) {
  const filename = name.endsWith('.json') ? name : `${name}.rubric.json`;
  return readJsonFile<Rubric>(deliveryEngineAssetPath('rubrics', filename));
}

export function deterministicCheckNameForGate(gate: RubricGate) {
  return typeof gate.check === 'object' ? gate.check.deterministic : undefined;
}

export function judgeOutputSchemaForRubric(rubric: Rubric) {
  const requiredGateIds = (rubric.gates ?? [])
    .filter((gate) => !deterministicCheckNameForGate(gate))
    .map((gate) => gate.id);
  const requiredDimensionIds = (rubric.dimensions ?? []).map((dimension) => dimension.id);

  return judgeOutputSchema.superRefine((value, context) => {
    const gateIds = new Set(value.gates.map((gate) => gate.id));
    const dimensionIds = new Set(value.dimensions.map((dimension) => dimension.id));

    for (const id of requiredGateIds) {
      if (!gateIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['gates'],
          message: `missing required LLM gate "${id}"`,
        });
      }
    }

    for (const id of requiredDimensionIds) {
      if (!dimensionIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['dimensions'],
          message: `missing required dimension "${id}"`,
        });
      }
    }
  });
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function aggregateJudgment({
  rubric,
  judgeOutput,
  deterministicResults = [],
  threshold = 0.7,
}: {
  rubric: Rubric;
  judgeOutput?: JudgeOutput;
  deterministicResults?: DeterministicGateResult[];
  threshold?: number;
}): AggregatedJudgment {
  if (!Number.isFinite(rubric.scale.min) || !Number.isFinite(rubric.scale.max)) {
    throw new Error('rubric scale must include finite min and max values');
  }
  if (rubric.scale.max <= rubric.scale.min) {
    throw new Error('rubric scale max must be greater than min');
  }

  const judge = judgeOutputSchema.parse(judgeOutput ?? {});
  const judgeGates = new Map(judge.gates.map((gate) => [gate.id, gate]));
  const detByGate = new Map<string, DeterministicGateResult>();
  for (const result of deterministicResults) {
    const key = result.id ?? result.check;
    if (key) detByGate.set(key, result);
  }

  const gates = (rubric.gates ?? []).map((gate): AggregatedGate => {
    const detName = deterministicCheckNameForGate(gate);
    const deterministic = detByGate.get(gate.id) ?? (detName ? detByGate.get(detName) : undefined);
    if (deterministic) {
      return {
        id: gate.id,
        passed: Boolean(deterministic.passed),
        evidence: deterministic.reason ?? 'deterministic check',
        source: 'deterministic',
      };
    }

    const judged = judgeGates.get(gate.id);
    if (judged) {
      return {
        id: gate.id,
        passed: Boolean(judged.passed),
        evidence: judged.evidence ?? '',
        source: 'llm',
      };
    }

    return {
      id: gate.id,
      passed: false,
      evidence: 'gate was not evaluated - failing closed',
      source: 'missing',
    };
  });

  const gatesFailed = gates.filter((gate) => !gate.passed);
  const rubricGates = new Map((rubric.gates ?? []).map((gate) => [gate.id, gate]));
  const rubricDimensions = new Map((rubric.dimensions ?? []).map((dimension) => [dimension.id, dimension]));
  const dimensions: JudgedDimension[] = judge.dimensions
    .filter((dimension) => rubricDimensions.has(dimension.id))
    .map((dimension) => ({
      ...dimension,
      weight: rubricDimensions.get(dimension.id)?.weight ?? 0,
    }));

  const scored = dimensions.filter((dimension): dimension is JudgedDimension & { score: number } => {
    return typeof dimension.score === 'number';
  });

  for (const dimension of scored) {
    if (dimension.score < rubric.scale.min || dimension.score > rubric.scale.max) {
      throw new Error(
        `dimension ${dimension.id} score ${dimension.score} outside scale [${rubric.scale.min},${rubric.scale.max}]`,
      );
    }
  }

  const missingDimensions = [...rubricDimensions.keys()].filter(
    (id) => !dimensions.some((dimension) => dimension.id === id),
  );
  const scoredWeight = scored.reduce((sum, dimension) => sum + dimension.weight, 0);
  const weightedScore = scored.reduce((sum, dimension) => sum + dimension.weight * dimension.score, 0);
  const overallUncapped =
    scoredWeight === 0
      ? 0
      : (weightedScore / scoredWeight - rubric.scale.min) / (rubric.scale.max - rubric.scale.min);

  const caps = gatesFailed.map((gate) => {
    const definition = rubricGates.get(gate.id);
    return definition?.on_fail === 'cap' ? (definition.cap_value ?? 0) : 0;
  });
  const overall = Math.min(overallUncapped, ...(caps.length ? caps : [Infinity]));

  const remediation = [
    ...gatesFailed.map((gate) => {
      const definition = rubricGates.get(gate.id);
      return `GATE ${gate.id} failed: ${gate.evidence || definition?.description || 'no evidence cited'}`;
    }),
    ...scored
      .filter((dimension) => dimension.score <= 2)
      .map((dimension) => {
        const definition = rubricDimensions.get(dimension.id);
        const target = definition?.anchors?.['5'] ?? definition?.description ?? 'improve this dimension';
        return `DIMENSION ${dimension.id} scored ${dimension.score}/5 (${dimension.evidence || 'no evidence cited'}). Target: ${target}`;
      }),
  ];

  const hasCriticalFailure = gatesFailed.some((gate) => rubricGates.get(gate.id)?.severity === 'critical');

  return {
    rubric: rubric.target?.name ?? 'unknown',
    overall: round3(overall),
    overall_uncapped: round3(overallUncapped),
    threshold,
    passed: !hasCriticalFailure && overall >= threshold && missingDimensions.length === 0,
    gates,
    gates_failed: gatesFailed.map((gate) => gate.id),
    dimensions_scored: scored.map(({ id, score, weight, evidence }) => ({ id, score, weight, evidence })),
    dimensions_not_scored: dimensions
      .filter((dimension) => typeof dimension.score !== 'number')
      .map(({ id, not_scored_reason }) => ({ id, reason: not_scored_reason ?? 'not scored' })),
    dimensions_missing: missingDimensions,
    remediation,
  };
}

export function buildJudgeArtifactPrompt({
  rubric,
  subjectName,
  subject,
  deterministicResults = [],
}: {
  rubric: Rubric;
  subjectName: string;
  subject: unknown;
  deterministicResults?: DeterministicGateResult[];
}) {
  const llmGates = (rubric.gates ?? []).filter((gate) => !deterministicCheckNameForGate(gate));
  const llmGateIds = llmGates.map((gate) => gate.id);
  const dimensionIds = (rubric.dimensions ?? []).map((dimension) => dimension.id);
  const deterministicSummary = deterministicResults.map((result) => ({
    id: result.id ?? result.check,
    passed: result.passed,
    reason: result.reason ?? 'deterministic check',
  }));
  const evaluationNotes = rubric.evaluation_notes?.length
    ? `\nEvaluation notes:\n${rubric.evaluation_notes.map((note) => `- ${note}`).join('\n')}\n`
    : '';

  return `Judge the artifact "${subjectName}" against the supplied rubric.

Return structured judge output only. Score every rubric dimension from ${rubric.scale.min} to ${rubric.scale.max}, or use null with a reason when evidence is genuinely unavailable. Evaluate only the listed LLM gates. Deterministic gates have already run and must not be rescored.

Required LLM gate ids, exactly once each: ${llmGateIds.length ? llmGateIds.join(', ') : '(none)'}
Required dimension ids, exactly once each: ${dimensionIds.length ? dimensionIds.join(', ') : '(none)'}
Empty gates or dimensions arrays are invalid when required ids are listed.
${evaluationNotes}

LLM gates:
${JSON.stringify(llmGates, null, 2)}

Dimensions:
${JSON.stringify(rubric.dimensions ?? [], null, 2)}

Deterministic gate results:
${JSON.stringify(deterministicSummary, null, 2)}

Artifact:
${JSON.stringify(subject, null, 2)}`;
}
