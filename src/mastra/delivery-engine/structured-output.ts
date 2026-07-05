import { z } from 'zod';

export type DeliveryStructuredOutputResponse = {
  object?: unknown;
  text?: string;
};

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

export function parseDeliveryStructuredOutput<T>(
  schema: z.ZodType<T>,
  response: DeliveryStructuredOutputResponse,
  label: string,
): T {
  const objectParsed = schema.safeParse(response.object);
  if (objectParsed.success) return objectParsed.data;

  const candidates = jsonTextCandidates(response.text);
  const parseErrors: string[] = [];

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
    response.object === undefined
      ? [
          'response.object was undefined',
          candidates.length
            ? `response.text did not contain JSON matching schema: ${parseErrors.at(-1)}`
            : 'response.text was empty or did not contain a JSON object',
        ].join('; ')
      : objectParsed.error.message;

  throw new Error(`${label} returned invalid structured output: ${reason}`);
}
