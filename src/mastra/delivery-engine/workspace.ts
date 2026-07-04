import { relative, resolve } from 'node:path';
import { Workspace, LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import { fileOwnership, matchesAny, noBcryptWeakHash } from './checks';
import { hasDeliveryDirectory, readDeliveryBoundary } from './state';
import { appendDeliveryEventState } from './state-service';
import type { MastraLike } from './observability';

function contextValue(requestContext: unknown, key: string) {
  const ctx = requestContext as { get?: (name: string) => unknown; [name: string]: unknown };
  if (typeof ctx?.get === 'function') return ctx.get(key);
  return ctx?.[key];
}

function repoPathFromContext(requestContext: unknown) {
  return String(contextValue(requestContext, 'repoPath') ?? process.cwd());
}

function mastraFromToolContext(context: unknown) {
  return (context as { mastra?: MastraLike } | undefined)?.mastra;
}

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

function repoRelativePath(repoPath: string, path: string) {
  const repo = resolve(repoPath);
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  return rel.startsWith('..') ? path : rel;
}

const writeToolNames = new Set<string>([
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
]);

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
      requireApproval: true,
    },
    hooks: {
      beforeToolCall: ({ workspaceToolName, input, context }) => {
        const requestContext = (context as { requestContext?: unknown })?.requestContext;
        const repoPath = repoPathFromContext(requestContext);
        const relativePaths = extractPaths(input).map((path) => repoRelativePath(repoPath, path));

        if (writeToolNames.has(workspaceToolName)) {
          const boundary = readDeliveryBoundary(repoPath);
          if (boundary && relativePaths.length) {
            const ownership = fileOwnership({ role: boundary.role, paths: relativePaths });
            if (!ownership.passed) {
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
                return {
                  proceed: false,
                  output: {
                    blocked: true,
                    reason: `${outsideTask} is outside this task's owned surfaces [${boundary.task_surfaces.join(', ')}]`,
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
              return {
                proceed: false,
                output: {
                  blocked: true,
                  reason: `Crypto policy violation: ${crypto.reason}`,
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
  skills: ['./src/mastra/delivery-engine/skills'],
  bm25: true,
});
