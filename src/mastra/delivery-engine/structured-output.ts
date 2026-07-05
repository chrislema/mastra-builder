import { z } from 'zod';

export type DeliveryStructuredOutputResponse = unknown;

type Candidate<T> = {
  path: string;
  value: T;
};

const MAX_CANDIDATES = 200;
const MAX_DEPTH = 8;
const SKIPPED_DIAGNOSTIC_KEYS = new Set([
  'abortSignal',
  'headers',
  'inputMessages',
  'metadata',
  'providerMetadata',
  'request',
  'schema',
  'structuredOutput',
  'toolCalls',
  'toolResults',
  'usage',
  'warnings',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathFor(parent: string, key: string | number) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

function parseJsonCandidate(candidate: string): unknown {
  return JSON.parse(candidate.trim());
}

function findBalancedJsonSnippets(text: string): string[] {
  const snippets: string[] = [];

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    const closer = opener === '{' ? '}' : opener === '[' ? ']' : undefined;
    if (!closer) continue;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char !== '}' && char !== ']') continue;

      const expected = stack.at(-1) === '{' ? '}' : ']';
      if (char !== expected) break;

      stack.pop();
      if (stack.length === 0) {
        snippets.push(text.slice(start, index + 1));
        break;
      }
    }
  }

  return snippets;
}

function jsonTextCandidates(text: string | undefined): string[] {
  const trimmed = text?.trim();
  if (!trimmed) return [];

  const candidates = [trimmed];
  const fencedJson = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fencedJson.exec(trimmed))) {
    candidates.push(match[1] ?? '');
  }

  candidates.push(...findBalancedJsonSnippets(trimmed));

  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function collectCandidates(value: unknown, path = 'response') {
  const objectCandidates: Candidate<unknown>[] = [];
  const textCandidates: Candidate<string>[] = [];
  const visited = new WeakSet<object>();

  function visit(current: unknown, currentPath: string, depth: number) {
    if (objectCandidates.length + textCandidates.length >= MAX_CANDIDATES || depth > MAX_DEPTH) return;

    if (typeof current === 'string') {
      const lastSegment = (currentPath.split('.').at(-1) ?? currentPath).replace(/\[\d+\]$/, '');
      const isLikelyOutputText = /^(text|content|message|output|response|result|reasoning)$/i.test(lastSegment);
      const isSkipped = currentPath.split('.').some((segment) => SKIPPED_DIAGNOSTIC_KEYS.has(segment));
      if (isLikelyOutputText && !isSkipped) {
        textCandidates.push({ path: currentPath, value: current });
      }
      return;
    }

    if (typeof current !== 'object' || current === null) return;
    if (visited.has(current)) return;
    visited.add(current);

    objectCandidates.push({ path: currentPath, value: current });

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, pathFor(currentPath, index), depth + 1));
      return;
    }

    for (const [key, nestedValue] of Object.entries(current)) {
      if (SKIPPED_DIAGNOSTIC_KEYS.has(key)) continue;
      visit(nestedValue, pathFor(currentPath, key), depth + 1);
    }
  }

  visit(value, path, 0);
  return { objectCandidates, textCandidates };
}

function directObject(value: unknown) {
  if (!isRecord(value) || !('object' in value)) return undefined;
  return value.object;
}

function directText(value: unknown) {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  return value.text;
}

function summarizeDiagnostics(response: DeliveryStructuredOutputResponse) {
  const topLevelKeys = isRecord(response) ? Object.keys(response).slice(0, 20) : [];
  const { objectCandidates, textCandidates } = collectCandidates(response);
  const objectPaths = objectCandidates
    .map((candidate) => candidate.path)
    .filter((path) => path !== 'response')
    .slice(0, 12);
  const textPaths = textCandidates
    .filter((candidate) => candidate.value.trim())
    .map((candidate) => `${candidate.path}(${candidate.value.length} chars)`)
    .slice(0, 12);

  return [
    topLevelKeys.length ? `top-level keys: ${topLevelKeys.join(', ')}` : 'top-level keys: none',
    objectPaths.length ? `object candidate paths: ${objectPaths.join(', ')}` : 'object candidate paths: none',
    textPaths.length ? `text candidate paths: ${textPaths.join(', ')}` : 'text candidate paths: none',
  ].join('; ');
}

export function parseDeliveryStructuredOutput<T>(
  schema: z.ZodType<T>,
  response: DeliveryStructuredOutputResponse,
  label: string,
): T {
  const responseObject = directObject(response);
  const objectParsed = schema.safeParse(responseObject);
  if (objectParsed.success) return objectParsed.data;

  const { objectCandidates, textCandidates } = collectCandidates(response);
  const directCandidate = directText(response);
  const candidates = [
    ...jsonTextCandidates(directCandidate),
    ...textCandidates.flatMap((candidate) => jsonTextCandidates(candidate.value)),
  ];
  const parseErrors: string[] = [];

  for (const candidate of objectCandidates) {
    if (candidate.path === 'response.object') continue;
    const nestedParsed = schema.safeParse(candidate.value);
    if (nestedParsed.success) return nestedParsed.data;
  }

  for (const candidate of candidates) {
    try {
      const textParsed = schema.safeParse(parseJsonCandidate(candidate));
      if (textParsed.success) return textParsed.data;
      parseErrors.push(textParsed.error.message);
    } catch (error) {
      parseErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const reason =
    responseObject === undefined
      ? [
          'response.object was undefined',
          candidates.length
            ? `response.text did not contain JSON matching schema: ${parseErrors.at(-1)}`
            : 'response.text was empty or did not contain a JSON object',
          summarizeDiagnostics(response),
        ].join('; ')
      : objectParsed.error.message;

  throw new Error(`${label} returned invalid structured output: ${reason}`);
}
