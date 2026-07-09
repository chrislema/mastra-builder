import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { SourcePolicy } from './workflow-schemas';

export type SourceDocument = { path: string; content: string };

const sourceFeatureIntentSchema = z.enum([
  'profile-state',
  'latest-transcript',
  'short-link-lifecycle',
  'external-service-bindings',
  'custom-domains',
  'pages',
]);

export const sourcePolicyIntentSchema = z
  .object({
    featureIntents: z.array(sourceFeatureIntentSchema).default([]),
    pagesRequired: z.boolean().optional(),
    requiredProfileKinds: z.array(z.string().min(1)).optional(),
    latestTranscriptRequired: z.boolean().optional(),
    shortLinkLifecycleRequired: z.boolean().optional(),
    externalServiceBindings: z.array(z.string().min(1)).optional(),
    customDomains: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export type SourcePolicyIntent = z.infer<typeof sourcePolicyIntentSchema>;

function sourceLineNegatesPages(line: string) {
  return (
    /\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b.{0,80}\b(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)\b/i.test(
      line,
    ) ||
    /\b(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)\b.{0,80}\b(?:not|unsupported|forbidden|banned)\b/i.test(
      line,
    )
  );
}

function sourceLineDeclaresPages(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes('?') || sourceLineNegatesPages(trimmed)) return false;

  const pagesProduct = String.raw`(?:Cloudflare\s+Pages|Pages\s+Functions?|PAGES)`;
  return [
    new RegExp(String.raw`\b(?:use|using|target|platform|deploy(?:ment)?|host(?:ing)?|build|create|implement|must|require[sd]?)\b.{0,100}\b${pagesProduct}\b`, 'i'),
    new RegExp(String.raw`\b${pagesProduct}\b.{0,100}\b(?:use|using|target|platform|deploy(?:ment)?|host(?:ing)?|must|require[sd]?)\b`, 'i'),
    new RegExp(String.raw`\b(?:deployment|target platform|platform)\s*:\s*${pagesProduct}\b`, 'i'),
  ].some((pattern) => pattern.test(trimmed));
}

export function sourceDocumentsDeclarePages(sourceDocuments: SourceDocument[]) {
  return sourceDocuments.some((document) => document.content.split(/\r?\n/).some(sourceLineDeclaresPages));
}

function sourceDocumentText(sourceDocuments: SourceDocument[]) {
  return sourceDocuments.map((document) => document.content).join('\n\n');
}

export function sourceDocumentsRequiredProfileKinds(sourceDocuments: SourceDocument[]) {
  const text = sourceDocumentText(sourceDocuments);
  const requiredKinds = new Set<string>();
  if (/\baudience_segments\b/i.test(text) || /\baudience\s+segments\s+profile\b/i.test(text)) {
    requiredKinds.add('audience_segments');
  }
  if (/\bvoice_profile\b/i.test(text) || /\bvoice\s+profile\b/i.test(text)) {
    requiredKinds.add('voice_profile');
  }
  return [...requiredKinds];
}

export function sourceDocumentsDeclareLatestTranscriptContract(sourceDocuments: SourceDocument[]) {
  const text = sourceDocumentText(sourceDocuments);
  return (
    /\btalking[-\s]?head\b/i.test(text) &&
    /\bTranscriptResult\b|\btranscript\s+result\b|\bready-to-record\b/i.test(text) &&
    /\bGET\s+\/latest\b|\/latest\b/i.test(text) &&
    (/\baudience_segments\b|\baudience\s+segments\s+profile\b/i.test(text) || /\bvoice_profile\b|\bvoice\s+profile\b/i.test(text))
  );
}

const standardCloudflareBindingNames = new Set(['AI', 'ASSETS', 'DB', 'ARTIFACTS', 'KV', 'R2']);

export function sourceDocumentsDeclareExternalServiceBindings(sourceDocuments: SourceDocument[]) {
  const text = sourceDocumentText(sourceDocuments);
  const bindings = new Set<string>();
  const patterns = [
    /\b(?:fetch|call|RPC|HTTP|API)\b.{0,80}\benv\.([A-Z][A-Z0-9_]*)\b/gi,
    /\benv\.([A-Z][A-Z0-9_]*)\b.{0,80}\b(?:fetch|call|RPC|HTTP|API)\b/gi,
    /\benv\.([A-Z][A-Z0-9_]*)\b(?=[\s\S]{0,120}\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding)\b)/gi,
    /\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding)\s+(?:named\s+|called\s+)?([A-Z][A-Z0-9_]*)\b/gi,
    /\b([A-Z][A-Z0-9_]*)\s+(?:external\s+Worker\s+service|Worker\s+service|service\s+binding)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== match[1].toUpperCase()) continue;
      const binding = match[1].toUpperCase();
      if (!standardCloudflareBindingNames.has(binding)) bindings.add(binding);
    }
  }

  return [...bindings].sort();
}

function sourceLineNegatesShortLinks(line: string) {
  return (
    /\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b.{0,100}(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?|\/api\/links|\/l\/)/i.test(
      line,
    ) ||
    /(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?|\/api\/links|\/l\/).{0,100}\b(?:not|unsupported|forbidden|banned)\b/i.test(
      line,
    )
  );
}

export function sourceDocumentsDeclareShortLinkLifecycle(sourceDocuments: SourceDocument[]) {
  const positiveText = sourceDocuments
    .flatMap((document) => document.content.split(/\r?\n/))
    .filter((line) => !sourceLineNegatesShortLinks(line))
    .join('\n');
  return /\b(?:short[-\s]?links?|url\s+shorteners?|link\s+shorteners?|shortened\s+urls?)\b/i.test(positiveText);
}

function sourceLineNegatesCustomDomain(line: string) {
  return /\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b.{0,100}\b(?:custom\s+domains?|domain\s+routes?)\b/i.test(
    line,
  );
}

function normalizeCustomDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

export function sourceDocumentsDeclareCustomDomains(sourceDocuments: SourceDocument[]) {
  const domains = new Set<string>();
  const hostnamePattern = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62})\b/gi;

  for (const line of sourceDocuments.flatMap((document) => document.content.split(/\r?\n/))) {
    if (sourceLineNegatesCustomDomain(line)) continue;
    if (!/\b(?:custom\s+domains?|domain\s+route|production\s+domain|deploy(?:ment)?\s+domain)\b/i.test(line)) continue;

    for (const match of line.matchAll(hostnamePattern)) {
      const domain = normalizeCustomDomain(match[1]);
      if (domain && !domain.endsWith('.workers.dev')) domains.add(domain);
    }
  }

  return [...domains].sort();
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeBindingName(binding: string) {
  return binding.trim().toUpperCase();
}

function normalizeDomainName(domain: string) {
  return normalizeCustomDomain(domain);
}

export function sourcePolicyFromDocuments(sourceDocuments: SourceDocument[], intentInput?: unknown): SourcePolicy {
  const intent = intentInput ? sourcePolicyIntentSchema.parse(intentInput) : undefined;
  const featureIntents = new Set(intent?.featureIntents ?? []);
  return {
    pagesRequired: intent?.pagesRequired ?? (featureIntents.has('pages') || sourceDocumentsDeclarePages(sourceDocuments)),
    requiredProfileKinds: uniqueStrings([
      ...sourceDocumentsRequiredProfileKinds(sourceDocuments),
      ...(intent?.requiredProfileKinds ?? []),
    ]),
    latestTranscriptRequired:
      intent?.latestTranscriptRequired ??
      (featureIntents.has('latest-transcript') || sourceDocumentsDeclareLatestTranscriptContract(sourceDocuments)),
    shortLinkLifecycleRequired:
      intent?.shortLinkLifecycleRequired ??
      (featureIntents.has('short-link-lifecycle') || sourceDocumentsDeclareShortLinkLifecycle(sourceDocuments)),
    externalServiceBindings: uniqueStrings([
      ...sourceDocumentsDeclareExternalServiceBindings(sourceDocuments),
      ...(intent?.externalServiceBindings ?? []).map(normalizeBindingName),
    ]).sort(),
    customDomains: uniqueStrings([
      ...sourceDocumentsDeclareCustomDomains(sourceDocuments),
      ...(intent?.customDomains ?? []).map(normalizeDomainName),
    ]).sort(),
  };
}

export function externalServiceAdapterPolicyLine(sourcePolicy: SourcePolicy) {
  const bindings = sourcePolicy.externalServiceBindings.map((binding) => `env.${binding}`);
  return bindings.length
    ? `\n- Source docs declare external Worker service binding(s): ${bindings.join(', ')}. Unknown service API shapes are not human blockers. Create a small typed adapter boundary around each source-declared binding, use the safest minimal fetch/RPC assumption from the source docs, and record unresolved contract details as risks instead of blocking unrelated tasks.`
    : '';
}

export function customDomainPolicyLine(sourcePolicy: SourcePolicy) {
  const customDomains = sourcePolicy.customDomains ?? [];
  return customDomains.length
    ? `\n- Source docs declare production custom domain route(s): ${customDomains.join(', ')}. Keep local validation on Wrangler staging, configure production custom-domain routing in wrangler.jsonc, and leave actual production activation behind the human-approved Wrangler deploy step.`
    : '';
}

export function sourceDocumentsFromRepo(repoPath: string) {
  const root = resolve(repoPath);
  return ['vision.md', 'spec.md'].flatMap((path) => {
    const fullPath = join(root, path);
    return existsSync(fullPath) ? [{ path, content: readFileSync(fullPath, 'utf8') }] : [];
  });
}

const sourcePolicyIntentPaths = ['delivery.intent.json', 'project.intent.json', '.delivery/intent.json'];

export function sourcePolicyIntentFromRepo(repoPath: string): SourcePolicyIntent | undefined {
  const root = resolve(repoPath);
  for (const path of sourcePolicyIntentPaths) {
    const fullPath = join(root, path);
    if (!existsSync(fullPath)) continue;

    const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
    return sourcePolicyIntentSchema.parse(parsed);
  }

  return undefined;
}

export function sourcePolicyFromRepo(repoPath: string): SourcePolicy {
  return sourcePolicyFromDocuments(sourceDocumentsFromRepo(repoPath), sourcePolicyIntentFromRepo(repoPath));
}
