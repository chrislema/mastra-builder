import { roleBoundaries, type DeliveryRole } from './boundaries';

export type CheckResult = {
  passed: boolean;
  reason: string;
};

export type DeliveryEvent = {
  ts?: string;
  source?: string;
  type: string;
  stage?: string;
  role?: string;
  tool?: string;
  paths?: string[];
  command?: string;
  ok?: boolean;
  artifact_type?: string;
  target?: string;
  revision?: string;
  [key: string]: unknown;
};

export type DeterministicCheckName =
  | 'release_blockers_zero'
  | 'dependency_graph_acyclic'
  | 'plan_schema_complete'
  | 'tier_order'
  | 'no_bcrypt_weak_hash'
  | 'file_ownership'
  | 'write_paths_in_boundary'
  | 'ran_code_before_complete'
  | 'no_code_artifacts_written'
  | 'harness_run_before_findings'
  | 'release_gate_read_before_deploy'
  | 'live_verify_after_deploy'
  | 'ended_explicitly';

const pass = (reason = 'ok'): CheckResult => ({ passed: true, reason });
const fail = (reason: string): CheckResult => ({ passed: false, reason });

export function globToRegExp(glob: string) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if ('.+^$()[]{}|\\'.includes(ch)) re += `\\${ch}`;
    else re += ch;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]) {
  const clean = path.replace(/^\.\//, '');
  return globs.some((glob) => globToRegExp(glob).test(clean));
}

export function stageSlice(events: DeliveryEvent[], stage?: string) {
  if (!stage) return events;
  const start = events.findIndex((event) => event.type === 'stage_start' && event.stage === stage);
  if (start === -1) return [];
  const end = events.findIndex(
    (event, index) => index > start && event.type === 'stage_end' && event.stage === stage,
  );
  return events.slice(start, end === -1 ? undefined : end + 1);
}

export function releaseBlockersZero(
  gate: { decision?: string; blockers?: unknown[]; critical_areas?: Array<{ status?: string }> },
  { mode = 'coherence' }: { mode?: 'coherence' | 'deployable' } = {},
) {
  const blockers = gate.blockers ?? [];
  const missing = (gate.critical_areas ?? []).filter((area) => area.status === 'missing');
  const clean = blockers.length === 0 && missing.length === 0;

  if (mode === 'deployable') {
    if (gate.decision !== 'pass') return fail(`gate decision is "${gate.decision}", not pass`);
    if (!clean) return fail(`open blockers: ${blockers.length}, missing critical areas: ${missing.length}`);
    return pass();
  }

  if (gate.decision === 'pass' && !clean) {
    return fail(
      `decision is PASS with ${blockers.length} open blocker(s) and ${missing.length} missing critical area(s)`,
    );
  }

  return pass();
}

export function dependencyGraphAcyclic(plan: { tasks?: Array<{ id: string; depends_on?: string[] }> }) {
  const tasks = plan.tasks ?? [];
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.depends_on ?? []) {
      if (!ids.has(dependency)) return fail(`${task.id} depends on unknown task "${dependency}"`);
    }
  }

  const indegree = new Map([...ids].map((id) => [id, 0]));
  for (const task of tasks) {
    for (const dependency of task.depends_on ?? []) {
      if (ids.has(dependency)) indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let seen = 0;

  while (queue.length) {
    const id = queue.shift();
    seen += 1;
    for (const task of tasks) {
      if ((task.depends_on ?? []).includes(id ?? '')) {
        indegree.set(task.id, (indegree.get(task.id) ?? 0) - 1);
        if (indegree.get(task.id) === 0) queue.push(task.id);
      }
    }
  }

  if (seen !== ids.size) {
    const cyclic = [...indegree].filter(([, count]) => count > 0).map(([id]) => id);
    return fail(`dependency cycle involving: ${cyclic.join(', ')}`);
  }

  return pass();
}

export function planSchemaComplete(artifact: unknown) {
  if (!artifact || typeof artifact !== 'object') return fail('artifact is not an object');
  const maybe = artifact as { artifact_type?: string; tasks?: unknown[]; decision?: string };

  if (maybe.artifact_type === 'task-plan' || Array.isArray(maybe.tasks)) {
    const tasks = maybe.tasks ?? [];
    if (!Array.isArray(tasks) || tasks.length === 0) return fail('task plan has no tasks');
    for (const [index, rawTask] of tasks.entries()) {
      const task = rawTask as Record<string, unknown>;
      for (const field of ['id', 'owner', 'deliverable', 'depends_on', 'acceptance_criteria', 'owned_surfaces']) {
        if (task[field] === undefined || task[field] === '') return fail(`task ${index + 1} missing ${field}`);
      }
    }
  }

  if (maybe.artifact_type === 'release-gate' && !maybe.decision) {
    return fail('release gate is missing decision');
  }

  return pass();
}

const tierOrder = ['smoke', 'api', 'e2e', 'full_matrix'];
const requiredTiers: Record<string, string[]> = {
  commit: ['smoke'],
  push: ['smoke', 'api', 'e2e'],
  pull_request: ['smoke', 'api', 'e2e'],
  pre_deployment: ['smoke', 'api', 'e2e', 'full_matrix'],
  production_deploy: ['smoke'],
};

export function tierOrderCheck(gate: { event_type?: string; tiers?: Array<{ tier: string; status: string }> }) {
  const eventType = gate.event_type ?? '';
  const required = requiredTiers[eventType];
  if (!required) return fail(`unknown event_type "${eventType}"`);

  const status = Object.fromEntries((gate.tiers ?? []).map((tier) => [tier.tier, tier.status]));
  for (const tier of required) {
    if (status[tier] !== 'passed') {
      return fail(`required tier "${tier}" is ${status[tier] ?? 'absent'} for event_type ${eventType}`);
    }
  }

  let earlierOk = true;
  for (const tier of tierOrder) {
    const current = status[tier];
    if ((current === 'passed' || current === 'failed') && !earlierOk) {
      return fail(`tier "${tier}" ran out of order - an earlier tier did not pass`);
    }
    if (current !== 'passed') earlierOk = earlierOk && (current === 'not_required' || current === undefined);
  }

  return pass();
}

export function noBcryptWeakHash(files: Array<{ path: string; content: string }>) {
  for (const { path, content } of files) {
    if (/\bbcrypt\b/i.test(content)) return fail(`${path}: bcrypt is banned - use PBKDF2 100k via Web Crypto`);
    if (/createHash\(\s*['"]md5['"]\s*\)|\bmd5\s*\(/i.test(content)) {
      return fail(`${path}: MD5 is banned for any security purpose`);
    }
    const mentionsPassword = /password/i.test(content);
    const usesSha256 = /createHash\(\s*['"]sha-?256['"]\s*\)|digest\(\s*['"]SHA-256['"]/i.test(content);
    const usesPbkdf2 = /PBKDF2/i.test(content);
    if (mentionsPassword && usesSha256 && !usesPbkdf2) {
      return fail(`${path}: unsalted/plain SHA-256 near password handling - use PBKDF2 100k`);
    }
  }
  return pass();
}

export function fileOwnership({ role, paths }: { role: DeliveryRole; paths: string[] }) {
  const boundary = roleBoundaries[role];
  if (!boundary) return fail(`unknown role "${role}"`);

  for (const path of paths) {
    if (path.startsWith('.delivery/')) continue;
    if (matchesAny(path, boundary.forbidden)) return fail(`${role} may not write ${path} (forbidden glob)`);
    if (boundary.owned.length === 0) return fail(`${role} owns no files but wrote ${path}`);
    if (!matchesAny(path, boundary.owned)) return fail(`${path} is outside ${role}'s owned globs`);
  }

  return pass();
}

const codeExec = (event: DeliveryEvent) =>
  event.type === 'run_code' ||
  (event.type === 'tool_use' && ['Bash', 'mastra_workspace_execute_command'].includes(String(event.tool)));
const isWrite = (event: DeliveryEvent) =>
  event.type === 'tool_use' &&
  ['Write', 'Edit', 'MultiEdit', 'mastra_workspace_write_file', 'mastra_workspace_edit_file', 'mastra_workspace_ast_edit'].includes(
    String(event.tool),
  );
const deliveryPath = (path: string) => path.startsWith('.delivery/');

export function writePathsInBoundary(events: DeliveryEvent[], { stage, role }: { stage?: string; role: DeliveryRole }) {
  const written = stageSlice(events, stage)
    .filter(isWrite)
    .flatMap((event) => event.paths ?? []);
  return fileOwnership({ role, paths: written });
}

export function ranCodeBeforeComplete(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const slice = stageSlice(events, stage);
  const end = slice.findIndex((event) => event.type === 'stage_end');
  const window = end === -1 ? slice : slice.slice(0, end);
  return window.some(codeExec) ? pass() : fail('stage completed without any code execution - confidence is not evidence');
}

export function noCodeArtifactsWritten(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const offending = stageSlice(events, stage)
    .filter(isWrite)
    .flatMap((event) => event.paths ?? [])
    .filter((path) => !deliveryPath(path));
  return offending.length ? fail(`wrote non-artifact files: ${offending.join(', ')}`) : pass();
}

export function harnessRunBeforeFindings(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const slice = stageSlice(events, stage);
  const firstFinding = slice.findIndex(
    (event) => event.type === 'artifact_write' && ['review-report', 'release-gate'].includes(String(event.artifact_type)),
  );
  if (firstFinding === -1) return pass('no findings written');
  const ranBefore = slice.slice(0, firstFinding).some(codeExec);
  return ranBefore ? pass() : fail('findings/gate written before any harness execution');
}

export function releaseGateReadBeforeDeploy(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const slice = stageSlice(events, stage);
  const firstDeploy = slice.findIndex((event) => event.type === 'deploy');
  if (firstDeploy === -1) return pass('no deploy occurred');
  const readBefore = slice
    .slice(0, firstDeploy)
    .some((event) => event.type === 'artifact_read' && event.artifact_type === 'release-gate');
  return readBefore ? pass() : fail('deployed without reading the release gate - deploying on optimism');
}

export function liveVerifyAfterDeploy(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const slice = stageSlice(events, stage);
  const deploys = slice.map((event, index) => (event.type === 'deploy' ? index : -1)).filter((index) => index !== -1);
  if (!deploys.length) return pass('no deploy occurred');
  for (const index of deploys) {
    if (!slice.slice(index + 1).some((event) => event.type === 'live_verify')) {
      return fail('deploy has no subsequent live_verify - success was not verified');
    }
  }
  return pass();
}

export function endedExplicitly(events: DeliveryEvent[], { stage }: { stage?: string } = {}) {
  const ends = stageSlice(events, stage).filter((event) => event.type === 'stage_end');
  if (!ends.length) return fail('no stage_end event - the stage never ended explicitly');
  const reason = ends[ends.length - 1]?.reason;
  return ['complete_stage', 'escalation'].includes(String(reason))
    ? pass()
    : fail(`stage ended by "${reason}" - thrash-to-timeout is a stability failure`);
}

export function runDeterministicCheck({
  name,
  subject,
  events,
  role,
  stage,
  mode,
  files,
  paths,
}: {
  name: DeterministicCheckName;
  subject?: any;
  events?: DeliveryEvent[];
  role?: DeliveryRole;
  stage?: string;
  mode?: 'coherence' | 'deployable';
  files?: Array<{ path: string; content: string }>;
  paths?: string[];
}) {
  switch (name) {
    case 'release_blockers_zero':
      return releaseBlockersZero(subject, { mode });
    case 'dependency_graph_acyclic':
      return dependencyGraphAcyclic(subject);
    case 'plan_schema_complete':
      return planSchemaComplete(subject);
    case 'tier_order':
      return tierOrderCheck(subject);
    case 'no_bcrypt_weak_hash':
      return noBcryptWeakHash(files ?? []);
    case 'file_ownership':
      if (!role) return fail('file_ownership requires role');
      return fileOwnership({ role, paths: paths ?? [] });
    case 'write_paths_in_boundary':
      if (!role) return fail('write_paths_in_boundary requires role');
      return writePathsInBoundary(events ?? [], { stage, role });
    case 'ran_code_before_complete':
      return ranCodeBeforeComplete(events ?? [], { stage });
    case 'no_code_artifacts_written':
      return noCodeArtifactsWritten(events ?? [], { stage });
    case 'harness_run_before_findings':
      return harnessRunBeforeFindings(events ?? [], { stage });
    case 'release_gate_read_before_deploy':
      return releaseGateReadBeforeDeploy(events ?? [], { stage });
    case 'live_verify_after_deploy':
      return liveVerifyAfterDeploy(events ?? [], { stage });
    case 'ended_explicitly':
      return endedExplicitly(events ?? [], { stage });
    default:
      return fail(`unknown check "${name}"`);
  }
}
