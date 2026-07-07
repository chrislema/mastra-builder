import { registerApiRoute } from '@mastra/core/server';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  deliveryWorkflowRunAsyncResponseSchema,
  deliveryWorkflowRunInputSchema,
  startDeliveryWorkflowRunAsync,
} from './runner';

const deliveryWorkflowRunErrorSchema = z.object({
  error: z.string(),
  issues: z.array(z.any()).optional(),
});

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function formText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function repoContainedFile({ repoPath, path, label }: { repoPath: string; path: string; label: string }) {
  const repo = resolve(repoPath);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repo, path);
  const rel = relative(repo, absolute).replaceAll('\\', '/');

  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`${label} file must be inside repoPath: ${path}`);
  }

  return { absolute, path: rel };
}

function existingRepoFile({ repoPath, path, label }: { repoPath: string; path: string; label: string }) {
  const file = repoContainedFile({ repoPath, path, label });
  if (!existsSync(file.absolute)) throw new Error(`${label} file not found: ${file.path}`);
  if (!statSync(file.absolute).isFile()) throw new Error(`${label} path is not a file: ${file.path}`);
  return file.path;
}

function launcherPage({
  error,
  started,
}: {
  error?: string;
  started?: { runId: string; resourceId: string; repoPath: string; visionPath: string; specPath?: string };
} = {}) {
  const repoPath = started?.repoPath ?? '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Delivery Run</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f4;
      --ink: #171717;
      --muted: #5d6462;
      --line: #d7d8d2;
      --panel: #ffffff;
      --accent: #176b5d;
      --accent-ink: #ffffff;
      --danger: #9c2f2f;
      --ok: #0f6a3d;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #151716;
        --ink: #f2f1ec;
        --muted: #a8aca7;
        --line: #343832;
        --panel: #1f2421;
        --accent: #5fb9a9;
        --accent-ink: #10201d;
        --danger: #ff9c91;
        --ok: #88d19d;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(980px, calc(100vw - 32px));
      margin: 32px auto;
    }
    h1 {
      margin: 0 0 18px;
      font-size: 26px;
      letter-spacing: 0;
    }
    form {
      display: grid;
      gap: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    label {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: transparent;
      color: var(--ink);
      font: inherit;
      padding: 10px 11px;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    button {
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: var(--accent-ink);
      font: inherit;
      font-weight: 750;
      padding: 10px 14px;
      cursor: pointer;
    }
    .notice {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 16px;
      background: var(--panel);
    }
    .error { color: var(--danger); }
    .started { color: var(--ok); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 760px) {
      .grid { grid-template-columns: 1fr; }
      main { width: min(100vw - 22px, 980px); margin: 18px auto; }
      form { padding: 16px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Delivery Run</h1>
    ${
      error
        ? `<div class="notice error">${escapeHtml(error)}</div>`
        : started
          ? `<div class="notice started">Started <code>${escapeHtml(started.runId)}</code> for <code>${escapeHtml(started.repoPath)}</code>. Source: <code>${escapeHtml(started.visionPath)}</code>${started.specPath ? ` and <code>${escapeHtml(started.specPath)}</code>` : ''}.</div>`
          : ''
    }
    <form method="post" action="/delivery/launcher">
      <label>
        Project folder
        <input name="repoPath" value="${escapeHtml(repoPath)}" placeholder="/Users/chrislema/personal/new-worker-app" required />
      </label>
      <div class="grid">
        <label>
          Vision path
          <input name="visionPath" value="vision.md" required />
        </label>
        <label>
          Spec path
          <input name="specPath" placeholder="spec.md" />
        </label>
      </div>
      <div class="grid">
        <label>
          Vision markdown
          <textarea name="visionContent" spellcheck="false"></textarea>
        </label>
        <label>
          Spec markdown
          <textarea name="specContent" spellcheck="false"></textarea>
        </label>
      </div>
      <div class="grid">
        <label>
          Deploy mode
          <select name="deployMode">
            <option value="local">local</option>
            <option value="production">production</option>
          </select>
        </label>
        <label>
          Review mode
          <select name="reviewMode">
            <option value="thorough">thorough</option>
            <option value="fast">fast</option>
          </select>
        </label>
      </div>
      <label>
        Max retries
        <input name="maxRetries" value="2" inputmode="numeric" />
      </label>
      <div class="actions">
        <button type="submit">Start Run</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

export const deliveryApiRoutes = [
  registerApiRoute('/delivery/launcher', {
    method: 'GET',
    openapi: {
      summary: 'Show the Delivery Engine run launcher',
      tags: ['Delivery Engine'],
      responses: {
        200: {
          description: 'HTML launcher form.',
        },
      },
    },
    handler: async () => htmlResponse(launcherPage()),
  }),
  registerApiRoute('/delivery/launcher', {
    method: 'POST',
    openapi: {
      summary: 'Start a Delivery Engine workflow run from the HTML launcher',
      tags: ['Delivery Engine'],
      responses: {
        202: {
          description: 'HTML confirmation page.',
        },
        400: {
          description: 'HTML validation error page.',
        },
      },
    },
    handler: async (c) => {
      const formData = await c.req.raw.formData();
      const repoPath = formText(formData, 'repoPath');
      const visionPath = formText(formData, 'visionPath') ?? 'vision.md';
      const specPath = formText(formData, 'specPath');
      const visionContent = formText(formData, 'visionContent');
      const specContent = formText(formData, 'specContent');

      try {
        if (!repoPath) throw new Error('Project folder is required.');
        const resolvedRepoPath = resolve(repoPath);
        const resolvedVisionPath = visionContent
          ? repoContainedFile({ repoPath: resolvedRepoPath, path: visionPath, label: 'vision' }).path
          : existingRepoFile({ repoPath: resolvedRepoPath, path: visionPath, label: 'vision' });
        const resolvedSpecPath =
          specContent || specPath
            ? specContent
              ? repoContainedFile({ repoPath: resolvedRepoPath, path: specPath ?? 'spec.md', label: 'spec' }).path
              : existingRepoFile({ repoPath: resolvedRepoPath, path: specPath as string, label: 'spec' })
            : undefined;

        const response = await startDeliveryWorkflowRunAsync(c.get('mastra') as any, {
          repoPath: resolvedRepoPath,
          visionPath: resolvedVisionPath,
          specPath: resolvedSpecPath,
          visionContent,
          specContent,
          deployMode: formText(formData, 'deployMode'),
          reviewMode: formText(formData, 'reviewMode') as 'fast' | 'thorough' | undefined,
          maxRetries: formText(formData, 'maxRetries'),
        });

        return htmlResponse(
          launcherPage({
            started: {
              runId: response.runId,
              resourceId: response.resourceId,
              repoPath: resolvedRepoPath,
              visionPath: resolvedVisionPath,
              specPath: resolvedSpecPath,
            },
          }),
          202,
        );
      } catch (error) {
        return htmlResponse(
          launcherPage({
            error: error instanceof Error ? error.message : String(error),
          }),
          400,
        );
      }
    },
  }),
  registerApiRoute('/delivery/run', {
    method: 'POST',
    openapi: {
      summary: 'Start a Delivery Engine workflow run',
      description:
        'Starts the registered delivery-workflow asynchronously with repoPath request context, resource scoping, and tracing metadata.',
      tags: ['Delivery Engine'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: deliveryWorkflowRunInputSchema,
          },
        },
      },
      responses: {
        202: {
          description: 'Delivery workflow run accepted and started asynchronously.',
          content: {
            'application/json': {
              schema: deliveryWorkflowRunAsyncResponseSchema,
            },
          },
        },
        400: {
          description: 'Invalid delivery workflow run request.',
          content: {
            'application/json': {
              schema: deliveryWorkflowRunErrorSchema,
            },
          },
        },
      },
    },
    handler: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const response = await startDeliveryWorkflowRunAsync(c.get('mastra') as any, body);
        return c.json(response, 202);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ error: 'invalid_delivery_workflow_run_request', issues: error.issues }, 400);
        }
        throw error;
      }
    },
  }),
];
