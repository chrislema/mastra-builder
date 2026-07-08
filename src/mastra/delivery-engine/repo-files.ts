import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeDeliveryPathReference } from './checks';

export function repoFileContents(repoPath: string, paths: Array<string | undefined>) {
  return paths
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    .map((path) => {
      const normalizedPath = normalizeDeliveryPathReference(path);
      const fullPath = isAbsolute(normalizedPath) ? normalizedPath : join(resolve(repoPath), normalizedPath);
      if (!existsSync(fullPath)) return undefined;
      return {
        path: normalizedPath,
        content: readFileSync(fullPath, 'utf8'),
      };
    })
    .filter((file): file is { path: string; content: string } => Boolean(file));
}
