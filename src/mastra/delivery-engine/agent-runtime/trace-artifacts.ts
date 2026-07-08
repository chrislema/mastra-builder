import type { MastraLike } from '../observability';
import { writeDeliveryArtifact } from '../state';
import { recordDeliveryArtifactState } from '../state-service';

export function responseText(response: unknown) {
  if (!response || typeof response !== 'object') return undefined;
  const text = (response as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function knownSecretValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(name) && typeof value === 'string')
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value && value.length >= 8));
}

export function redactSecretsFromText(text: string) {
  return knownSecretValues().reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
}

export function redactTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsFromText(value);
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactTraceValue(item)]));
}

export function serializeAgentResponse(response: unknown) {
  if (!response || typeof response !== 'object') return redactTraceValue(response);
  const record = response as Record<string, unknown>;
  return redactTraceValue({
    text: record.text,
    object: record.object,
    finishReason: record.finishReason,
    usage: record.usage,
    warnings: record.warnings,
  });
}

export async function writeStageTraceArtifact({
  repoPath,
  mastra,
  artifactType,
  artifactPath,
  trace,
}: {
  repoPath: string;
  mastra?: MastraLike;
  artifactType: string;
  artifactPath: string;
  trace: unknown;
}) {
  writeDeliveryArtifact({
    repoPath,
    artifactPath,
    artifact: redactTraceValue(trace),
  });
  await recordDeliveryArtifactState({
    repoPath,
    type: artifactType,
    path: artifactPath,
    mastra,
  });
  return artifactPath;
}
