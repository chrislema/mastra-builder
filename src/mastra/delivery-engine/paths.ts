import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function repoRelativeExistingFile({
  repoPath,
  path,
  label,
}: {
  repoPath: string;
  path: string;
  label: string;
}) {
  const repo = resolve(repoPath);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repo, path);
  const rel = relative(repo, absolute);

  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} file must be inside repoPath: ${path}`);
  }

  if (!existsSync(absolute)) throw new Error(`${label} file not found: ${rel}`);
  if (!statSync(absolute).isFile()) throw new Error(`${label} path is not a file: ${rel}`);

  return rel;
}
