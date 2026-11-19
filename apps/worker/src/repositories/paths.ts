import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export async function resolveTarget(root: string, path: string): Promise<string> {
  if (
    !path ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error('Choose a relative folder path without dot segments');
  }
  const canonical = await realpath(root);
  const target = resolve(canonical, path);
  const rel = relative(canonical, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Repository must be beneath the Worker workspace');
  }
  let parent = canonical;
  for (const part of relative(canonical, dirname(target)).split(sep).filter(Boolean)) {
    parent = resolve(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Parent folders must be real directories');
  }
  if ((await realpath(dirname(target))) !== dirname(target))
    throw new Error('Symlinked paths are not supported');
  return target;
}
