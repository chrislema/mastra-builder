import {
  type NormalizedProjectFactoryInput,
  type ProjectLanguage,
  type ProjectProfile,
  projectFactoryInputSchema,
} from './schemas';

const profileOrder: ProjectProfile[] = [
  'worker-vanilla-js',
  'worker-typescript',
  'worker-workers-ai',
  'worker-d1',
  'worker-kv',
  'worker-r2',
  'worker-workflows',
  'worker-authenticated-admin',
  'pages-explicit',
];

function sourceText(input: NormalizedProjectFactoryInput) {
  return input.sourceDocuments.map((document) => document.content).join('\n\n');
}

function localFeaturePattern(pattern: RegExp) {
  return new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
}

function sourceFeatureChunks(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized];
}

function sourceMentions(text: string, pattern: RegExp) {
  const localPattern = localFeaturePattern(pattern);
  return sourceFeatureChunks(text).some((chunk) => {
    const match = localPattern.exec(chunk);
    if (!match || match.index === undefined) return false;

    const before = chunk.slice(Math.max(0, match.index - 100), match.index);
    const after = chunk.slice(match.index + match[0].length, match.index + match[0].length + 100);
    if (/\b(?:no|not|never|avoid|without|forbid|forbidden|ban|banned|do\s+not|don't)\b/i.test(before)) return false;
    if (/\b(?:not|unsupported|forbidden|banned|unwanted|excluded)\b/i.test(after)) return false;
    return true;
  });
}

function wantsTypeScript(input: NormalizedProjectFactoryInput, featureProfiles: Set<ProjectProfile>): boolean {
  if (input.language) return input.language === 'typescript';
  if (featureProfiles.size > 0) return true;
  if (input.sourcePolicy.externalServiceBindings.length > 0) return true;
  if (input.sourcePolicy.requiredProfileKinds.length > 0) return true;
  if (input.sourcePolicy.latestTranscriptRequired) return true;

  const text = sourceText(input);
  if (sourceMentions(text, /\bTypeScript\b|\bTS\b|\.ts\b/i)) return true;
  if (sourceMentions(text, /\bplain\s+(?:HTML|CSS|JavaScript|JS)\b|\bvanilla\s+(?:HTML|CSS|JavaScript|JS)\b/i)) {
    return false;
  }

  return false;
}

export function normalizeProjectName(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54);

  return normalized || 'worker-app';
}

export function normalizeProjectFactoryInput(input: unknown): NormalizedProjectFactoryInput {
  return projectFactoryInputSchema.parse(input);
}

export function selectProjectProfiles(input: unknown): ProjectProfile[] {
  const normalized = normalizeProjectFactoryInput(input);
  const text = sourceText(normalized);
  const requestedProfiles = new Set(normalized.requestedProfiles);
  const featureProfiles = new Set<ProjectProfile>();

  if (normalized.sourcePolicy.pagesRequired || requestedProfiles.has('pages-explicit')) {
    featureProfiles.add('pages-explicit');
  }

  if (requestedProfiles.has('worker-workers-ai') || sourceMentions(text, /\bWorkers\s+AI\b|\benv\.AI\b|\bAI\s+binding\b|\bAI\.run\b|@cf\//i)) {
    featureProfiles.add('worker-workers-ai');
  }

  if (
    requestedProfiles.has('worker-d1') ||
    normalized.sourcePolicy.latestTranscriptRequired ||
    sourceMentions(text, /\bCloudflare\s+D1\b|\bD1\b|\bSQLite\b|\bSQL\b|\bmigrations?\b/i) ||
    sourceMentions(text, /\bstore\s+(?:runs|records|transcripts|candidates)\b|\bpersist(?:ent)?\s+(?:runs|records|transcripts|state)\b/i)
  ) {
    featureProfiles.add('worker-d1');
  }

  if (requestedProfiles.has('worker-kv') || sourceMentions(text, /\bCloudflare\s+KV\b|\bKV\b|\bkey[-\s]?value\b/i)) {
    featureProfiles.add('worker-kv');
  }

  if (requestedProfiles.has('worker-r2') || sourceMentions(text, /\bCloudflare\s+R2\b|\bR2\b|\bobject\s+storage\b|\bbucket\b/i)) {
    featureProfiles.add('worker-r2');
  }

  if (
    requestedProfiles.has('worker-workflows') ||
    sourceMentions(text, /\bCloudflare\s+Workers\s+Workflows\b|\bWorkers\s+Workflows\b|\bWorkflowEntrypoint\b/i)
  ) {
    featureProfiles.add('worker-workflows');
  }

  if (requestedProfiles.has('worker-authenticated-admin') || sourceMentions(text, /\bauthenticated\s+admin\b|\badmin\s+login\b|\badmin\s+session\b/i)) {
    featureProfiles.add('worker-authenticated-admin');
  }

  for (const profile of requestedProfiles) {
    if (profile !== 'worker-vanilla-js' && profile !== 'worker-typescript') featureProfiles.add(profile);
  }

  const language: ProjectLanguage = wantsTypeScript(normalized, featureProfiles) ? 'typescript' : 'javascript';
  const profiles = new Set<ProjectProfile>([language === 'typescript' ? 'worker-typescript' : 'worker-vanilla-js']);

  for (const profile of featureProfiles) profiles.add(profile);

  return profileOrder.filter((profile) => profiles.has(profile));
}

export function languageForProfiles(profiles: ProjectProfile[]): ProjectLanguage {
  return profiles.includes('worker-typescript') ? 'typescript' : 'javascript';
}

export function hasProfile(profiles: ProjectProfile[], profile: ProjectProfile) {
  return profiles.includes(profile);
}
