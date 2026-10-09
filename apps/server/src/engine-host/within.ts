import path from 'node:path';

/** `child` is `parent` itself or lies inside it, by whole path components. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
