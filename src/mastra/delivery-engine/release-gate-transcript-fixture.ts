import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SourcePolicy } from './workflow-schemas';

export type ReleaseGateTranscriptFixtureContext = {
  repoPath: string;
  sourcePolicy: SourcePolicy;
  latestRoutePresent: boolean;
  localD1DatabaseName?: string;
  migrationText: string;
};

function releaseGateTableColumns(schema: string, tableName: string) {
  const columns = new Set<string>();
  const escapedTable = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tableMatch = new RegExp(
    `CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${escapedTable}\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    'i',
  ).exec(schema);
  if (!tableMatch) return columns;

  for (const segment of tableMatch[1].split(/,|\r?\n/)) {
    const match = segment.match(/^\s*([A-Za-z_][\w]*)\s+/);
    if (!match) continue;
    const column = match[1].toLowerCase();
    if (['constraint', 'primary', 'foreign', 'unique', 'check'].includes(column)) continue;
    columns.add(column);
  }

  return columns;
}

function releaseGateMissingTableColumns(schema: string, tableName: string, requiredColumns: string[]) {
  const columns = releaseGateTableColumns(schema, tableName);
  if (!columns.size) return [`${tableName} table is missing`];
  return requiredColumns.filter((column) => !columns.has(column));
}

export function releaseGateTranscriptFixtureSchemaGaps(context: ReleaseGateTranscriptFixtureContext) {
  if (!context.sourcePolicy.latestTranscriptRequired) return [];
  if (!context.latestRoutePresent) return [];

  const schema = context.migrationText;
  if (!schema.trim()) return ['GET /latest route is present but migrations/ contains no SQL schema.'];

  const checks = [
    {
      table: 'runs',
      columns: [
        'id',
        'status',
        'window_start',
        'window_end',
        'audience_profile_id',
        'voice_profile_id',
        'selected_candidate_id',
        'transcript_id',
        'error_message',
        'created_at',
        'updated_at',
      ],
    },
    {
      table: 'candidates',
      columns: [
        'id',
        'run_id',
        'bookmark_id',
        'link_id',
        'source_url',
        'title',
        'author',
        'published_at',
        'summary',
        'core_idea',
        'suggested_angle',
        'primary_segment',
        'segment_fit_json',
        'created_at',
      ],
    },
    {
      table: 'transcripts',
      columns: [
        'id',
        'run_id',
        'candidate_id',
        'audience_profile_id',
        'voice_profile_id',
        'title',
        'hook',
        'transcript',
        'captions_json',
        'source_urls_json',
        'why_this_was_picked',
        'primary_segment',
        'alternate_angles_json',
        'word_count',
        'created_at',
      ],
    },
  ];

  return checks.flatMap(({ table, columns }) =>
    releaseGateMissingTableColumns(schema, table, columns).map((missing) =>
      missing.endsWith('table is missing')
        ? missing
        : `${table}.${missing} is required for seeded GET /latest release-gate validation`,
    ),
  );
}

export function releaseGateTranscriptFixtureAvailable(context: ReleaseGateTranscriptFixtureContext) {
  const schema = context.migrationText;
  return (
    context.sourcePolicy.latestTranscriptRequired &&
    Boolean(context.localD1DatabaseName) &&
    context.latestRoutePresent &&
    /\bCREATE\s+TABLE\s+runs\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+candidates\b/i.test(schema) &&
    /\bCREATE\s+TABLE\s+transcripts\b/i.test(schema) &&
    releaseGateTranscriptFixtureSchemaGaps(context).length === 0
  );
}

export function releaseGateTranscriptVersionAuditSql() {
  return "SELECT COUNT(*) AS transcript_versions, SUM(CASE WHEN id = 'release-gate-transcript-v1' THEN 1 ELSE 0 END) AS preserved_original_versions, SUM(CASE WHEN id = 'release-gate-transcript-v2' THEN 1 ELSE 0 END) AS regenerated_versions, (SELECT transcript_id FROM runs WHERE id = 'release-gate-run') AS active_transcript_id FROM transcripts WHERE run_id = 'release-gate-run'";
}

export function releaseGateTranscriptFixtureSql() {
  return [
    '-- Release-gate fixture: completed run plus original and regenerated transcript versions.',
    'PRAGMA foreign_keys = OFF;',
    "INSERT OR REPLACE INTO candidates (id, run_id, bookmark_id, link_id, source_url, title, author, published_at, summary, core_idea, suggested_angle, primary_segment, segment_fit_json, created_at) VALUES ('release-gate-candidate', 'release-gate-run', 'release-gate-bookmark', NULL, 'https://example.com/release-gate-source', 'Release Gate Candidate', 'Release Gate', '2026-01-01T00:00:00.000Z', 'Fixture candidate for release-gate transcript persistence.', 'Prove completed transcript persistence through GET /latest.', 'Show that the latest transcript is served from D1.', 'operators', '[{\"segmentName\":\"operators\",\"relevance\":5}]', '2026-01-01T00:00:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v1', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Original Transcript', 'Original hook.', 'Original transcript retained for audit.', '[\"Original caption\"]', '[\"https://example.com/release-gate-source\"]', 'Original selection rationale.', 'operators', '[\"Original alternate angle\"]', 5, '2026-01-01T00:05:00.000Z');",
    "INSERT OR REPLACE INTO transcripts (id, run_id, candidate_id, audience_profile_id, voice_profile_id, title, hook, transcript, captions_json, source_urls_json, why_this_was_picked, primary_segment, alternate_angles_json, word_count, created_at) VALUES ('release-gate-transcript-v2', 'release-gate-run', 'release-gate-candidate', 'release-gate-audience', 'release-gate-voice', 'Release Gate Regenerated Transcript', 'Regenerated hook.', 'Regenerated transcript served as latest while the original remains stored.', '[\"Regenerated caption\"]', '[\"https://example.com/release-gate-source\"]', 'Regenerated selection rationale.', 'operators', '[\"Regenerated alternate angle\"]', 9, '2026-01-01T00:10:00.000Z');",
    "INSERT OR REPLACE INTO runs (id, status, window_start, window_end, audience_profile_id, voice_profile_id, selected_candidate_id, transcript_id, error_message, created_at, updated_at) VALUES ('release-gate-run', 'completed', '2025-12-25T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'release-gate-audience', 'release-gate-voice', 'release-gate-candidate', 'release-gate-transcript-v2', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z');",
    'PRAGMA foreign_keys = ON;',
    '',
  ].join('\n');
}

export function writeReleaseGateTranscriptFixtureFile(repoPath: string) {
  const fixturePath = join(resolve(repoPath), '.delivery', 'tmp', 'release-gate-transcript-fixture.sql');
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, releaseGateTranscriptFixtureSql());
  return '.delivery/tmp/release-gate-transcript-fixture.sql';
}
