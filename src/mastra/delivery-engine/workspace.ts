import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace, LocalFilesystem, LocalSandbox, LocalSkillSource, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { fileOwnership, matchesAny, noBcryptWeakHash, stageSlice } from './checks';
import { deliveryRepoPathFromRequestContext } from './context';
import { hasDeliveryDirectory, readDeliveryBoundary, readDeliveryEvents, type DeliveryBoundary } from './state';
import { appendDeliveryEventState } from './state-service';
import type { MastraLike } from './observability';

function repoPathFromContext(requestContext: unknown) {
  return deliveryRepoPathFromRequestContext(requestContext);
}

function mastraFromToolContext(context: unknown) {
  return (context as { mastra?: MastraLike } | undefined)?.mastra;
}

const deliverySkillRootRelativePath = 'src/mastra/delivery-engine/skills';

function hasDeliverySkillRoot(basePath: string) {
  return existsSync(resolve(basePath, deliverySkillRootRelativePath));
}

function findDeliveryProjectRoot(startPath?: string) {
  if (!startPath) return undefined;
  let current = resolve(startPath);

  while (true) {
    if (hasDeliverySkillRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function deliveryProjectRootForSkills() {
  const starts = [
    process.env.MASTRA_PROJECT_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ];

  for (const start of starts) {
    const root = findDeliveryProjectRoot(start);
    if (root) return root;
  }

  return process.cwd();
}

export const deliverySkillRoot = resolve(deliveryProjectRootForSkills(), deliverySkillRootRelativePath);
export const deliveryWorkspaceSkillPaths = [deliverySkillRoot];
export const deliverySkillPath = (name: string) => resolve(deliverySkillRoot, name);

function extractPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = input as Record<string, unknown>;
  const candidates = [
    value.path,
    value.filePath,
    value.file_path,
    value.from,
    value.to,
    value.target,
    value.destination,
  ];
  const paths = candidates.filter((candidate): candidate is string => typeof candidate === 'string');
  if (Array.isArray(value.paths)) {
    paths.push(...value.paths.filter((path): path is string => typeof path === 'string'));
  }
  return paths;
}

function extractContent(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const value = input as Record<string, unknown>;
  const fragments = [value.content, value.newString, value.new_string, value.replacement].filter(
    (fragment): fragment is string => typeof fragment === 'string',
  );

  if (Array.isArray(value.edits)) {
    for (const edit of value.edits) {
      if (edit && typeof edit === 'object') {
        const next = edit as Record<string, unknown>;
        if (typeof next.newString === 'string') fragments.push(next.newString);
        if (typeof next.new_string === 'string') fragments.push(next.new_string);
        if (typeof next.replacement === 'string') fragments.push(next.replacement);
      }
    }
  }

  return fragments;
}

function extractCommand(input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function repoRelativePath(repoPath: string, path: string) {
  const repo = resolve(repoPath);
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  return rel.startsWith('..') ? path : rel;
}

function blockedCommandReason(command: string) {
  const checks = [
    { pattern: /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/, reason: 'recursive force delete requires human review' },
    { pattern: /\bgit\s+(reset|clean|checkout)\b/, reason: 'destructive git state changes require human review' },
    { pattern: /\bsudo\b/, reason: 'sudo commands are outside the delivery workspace contract' },
    { pattern: /\b(chmod|chown)\s+-R\b/, reason: 'recursive permission changes require human review' },
    { pattern: /\b(curl|wget)\b.+\|\s*(sh|bash)\b/, reason: 'piping remote scripts into a shell requires human review' },
  ];

  return checks.find((check) => check.pattern.test(command))?.reason;
}

const writeToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);
const dependencyReadToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
]);

function isDependencyPath(path: string) {
  const clean = path.replace(/^\.\//, '');
  return clean === 'node_modules' || clean.startsWith('node_modules/');
}

const envPositiveInt = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
};

const maxReadToolsBeforeWrite = envPositiveInt('DELIVERY_MAX_READ_TOOLS_BEFORE_WRITE', 6);

function isExistingDirectory(repoPath: string, path: string) {
  try {
    return statSync(resolve(repoPath, path)).isDirectory();
  } catch {
    return false;
  }
}

function hasSuccessfulWorkspaceWrite(events: ReturnType<typeof readDeliveryEvents>, stage: string) {
  return stageSlice(events, stage).some(
    (event) => event.type === 'tool_use' && event.ok === true && typeof event.tool === 'string' && writeToolNames.has(event.tool),
  );
}

function successfulReadToolCount(events: ReturnType<typeof readDeliveryEvents>, stage: string) {
  return stageSlice(events, stage).filter(
    (event) =>
      event.type === 'tool_use' &&
      event.ok === true &&
      typeof event.tool === 'string' &&
      dependencyReadToolNames.has(event.tool),
  ).length;
}

export function deliveryReadToolBlockReason({
  repoPath,
  workspaceToolName,
  relativePaths,
  boundary = readDeliveryBoundary(repoPath),
}: {
  repoPath: string;
  workspaceToolName: string;
  relativePaths: string[];
  boundary?: DeliveryBoundary;
}) {
  if (!dependencyReadToolNames.has(workspaceToolName)) return undefined;

  if (workspaceToolName === WORKSPACE_TOOLS.FILESYSTEM.READ_FILE) {
    const directoryPath = relativePaths.find((path) => isExistingDirectory(repoPath, path));
    if (directoryPath) {
      return `${directoryPath} is a directory. List files in that directory and read a concrete file path instead.`;
    }
  }

  if (!boundary || !/^build:/.test(boundary.stage)) return undefined;
  const events = readDeliveryEvents(repoPath);
  if (hasSuccessfulWorkspaceWrite(events, boundary.stage)) return undefined;

  const readCount = successfulReadToolCount(events, boundary.stage);
  if (readCount >= maxReadToolsBeforeWrite) {
    return `Build stage ${boundary.stage} already used ${readCount} read/list tool calls before any write. Stop investigating and write or edit the task's owned surfaces.`;
  }

  return undefined;
}

function recordBlockedToolCall({
  repoPath,
  workspaceToolName,
  input,
  reason,
  context,
}: {
  repoPath: string;
  workspaceToolName: string;
  input: unknown;
  reason: string;
  context: unknown;
}) {
  if (!hasDeliveryDirectory(repoPath)) return;
  void appendDeliveryEventState({
    repoPath,
    mastra: mastraFromToolContext(context),
    event: {
      type: 'tool_use',
      tool: workspaceToolName,
      ok: false,
      paths: extractPaths(input).map((path) => repoRelativePath(repoPath, path)),
      command: extractCommand(input)?.slice(0, 500),
      error: reason,
    },
  }).catch(() => undefined);
}

export const deliveryWorkspace = new Workspace({
  id: 'delivery-workspace',
  name: 'Delivery Workspace',
  filesystem: ({ requestContext }) =>
    new LocalFilesystem({
      basePath: repoPathFromContext(requestContext),
      contained: true,
    }),
  sandbox: ({ requestContext }) =>
    new LocalSandbox({
      workingDirectory: repoPathFromContext(requestContext),
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    }),
  instructions: {
    dynamicSandbox: ({ requestContext }) => `Commands run from ${repoPathFromContext(requestContext)}.`,
  },
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      requireApproval: false,
    },
    hooks: {
      beforeToolCall: ({ workspaceToolName, input, context }) => {
        const requestContext = (context as { requestContext?: unknown })?.requestContext;
        const repoPath = repoPathFromContext(requestContext);
        const relativePaths = extractPaths(input).map((path) => repoRelativePath(repoPath, path));

        if (workspaceToolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) {
          const command = extractCommand(input);
          const reason = command ? blockedCommandReason(command) : undefined;
          if (reason) {
            recordBlockedToolCall({ repoPath, workspaceToolName, input, reason, context });
            return {
              proceed: false,
              output: {
                blocked: true,
                reason,
              },
            };
          }
        }

        if (dependencyReadToolNames.has(workspaceToolName)) {
          const boundary = readDeliveryBoundary(repoPath);
          const readBlockReason = deliveryReadToolBlockReason({
            repoPath,
            workspaceToolName,
            relativePaths,
            boundary,
          });
          if (readBlockReason) {
            recordBlockedToolCall({ repoPath, workspaceToolName, input, reason: readBlockReason, context });
            return {
              proceed: false,
              output: {
                blocked: true,
                reason: readBlockReason,
              },
            };
          }

          const dependencyPath = boundary ? relativePaths.find(isDependencyPath) : undefined;
          if (dependencyPath) {
            const reason = `Reading ${dependencyPath} is blocked during delivery stages; rely on project types and workflow verification instead.`;
            recordBlockedToolCall({ repoPath, workspaceToolName, input, reason, context });
            return {
              proceed: false,
              output: {
                blocked: true,
                reason,
              },
            };
          }
        }

        if (writeToolNames.has(workspaceToolName)) {
          const boundary = readDeliveryBoundary(repoPath);
          if (boundary && relativePaths.length) {
            const ownership = fileOwnership({ role: boundary.role, paths: relativePaths });
            if (!ownership.passed) {
              recordBlockedToolCall({ repoPath, workspaceToolName, input, reason: ownership.reason, context });
              return {
                proceed: false,
                output: {
                  blocked: true,
                  reason: ownership.reason,
                },
              };
            }

            if (boundary.task_surfaces?.length) {
              const outsideTask = relativePaths.find(
                (path) => !path.startsWith('.delivery/') && !matchesAny(path, boundary.task_surfaces ?? []),
              );
              if (outsideTask) {
                const reason = `${outsideTask} is outside this task's owned surfaces [${boundary.task_surfaces.join(', ')}]`;
                recordBlockedToolCall({ repoPath, workspaceToolName, input, reason, context });
                return {
                  proceed: false,
                  output: {
                    blocked: true,
                    reason,
                  },
                };
              }
            }
          }

          const content = extractContent(input);
          if (content.length) {
            const files = relativePaths.length ? relativePaths : ['<workspace-edit>'];
            const crypto = noBcryptWeakHash(
              content.map((fragment, index) => ({
                path: files[index] ?? files[0] ?? '<workspace-edit>',
                content: fragment,
              })),
            );
            if (!crypto.passed) {
              const reason = `Crypto policy violation: ${crypto.reason}`;
              recordBlockedToolCall({ repoPath, workspaceToolName, input, reason, context });
              return {
                proceed: false,
                output: {
                  blocked: true,
                  reason,
                },
              };
            }
          }
        }

        return undefined;
      },
      afterToolCall: async ({ workspaceToolName, input, output, error, context }) => {
        const requestContext = (context as { requestContext?: unknown })?.requestContext;
        const repoPath = repoPathFromContext(requestContext);
        if (!hasDeliveryDirectory(repoPath)) return;

        await appendDeliveryEventState({
          repoPath,
          mastra: mastraFromToolContext(context),
          event: {
            type: 'tool_use',
            tool: workspaceToolName,
            ok: !error,
            paths: extractPaths(input).map((path) => repoRelativePath(repoPath, path)),
            command:
              typeof (input as { command?: unknown })?.command === 'string'
                ? String((input as { command: string }).command).slice(0, 500)
                : undefined,
            output_summary: output ? 'workspace tool produced output' : undefined,
            error: error instanceof Error ? error.message : error ? String(error) : undefined,
          },
        });
      },
    },
  },
  skills: deliveryWorkspaceSkillPaths,
  skillSource: new LocalSkillSource({ basePath: deliveryProjectRootForSkills() }),
  checkSkillFileMtime: true,
  bm25: true,
});
