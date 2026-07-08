import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SourcePolicy } from './workflow-schemas';

export type SourceDocument = { path: string; content: string };

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

export function sourceDocumentsDeclareTalkingHeadTranscriptContract(sourceDocuments: SourceDocument[]) {
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

export function sourcePolicyFromDocuments(sourceDocuments: SourceDocument[]): SourcePolicy {
  return {
    pagesRequired: sourceDocumentsDeclarePages(sourceDocuments),
    requiredProfileKinds: sourceDocumentsRequiredProfileKinds(sourceDocuments),
    talkingHeadTranscriptRequired: sourceDocumentsDeclareTalkingHeadTranscriptContract(sourceDocuments),
    externalServiceBindings: sourceDocumentsDeclareExternalServiceBindings(sourceDocuments),
  };
}

export function externalServiceAdapterPolicyLine(sourcePolicy: SourcePolicy) {
  const bindings = sourcePolicy.externalServiceBindings.map((binding) => `env.${binding}`);
  return bindings.length
    ? `\n- Source docs declare external Worker service binding(s): ${bindings.join(', ')}. Unknown service API shapes are not human blockers. Create a small typed adapter boundary around each source-declared binding, use the safest minimal fetch/RPC assumption from the source docs, and record unresolved contract details as risks instead of blocking unrelated tasks.`
    : '';
}

export function sourceDocumentsFromRepo(repoPath: string) {
  const root = resolve(repoPath);
  return ['vision.md', 'spec.md'].flatMap((path) => {
    const fullPath = join(root, path);
    return existsSync(fullPath) ? [{ path, content: readFileSync(fullPath, 'utf8') }] : [];
  });
}

export function sourcePolicyFromRepo(repoPath: string): SourcePolicy {
  return sourcePolicyFromDocuments(sourceDocumentsFromRepo(repoPath));
}
