import path from 'node:path';

/** `child` is `parent` itself or lies inside it, by whole path components (the text only; the disk is not read). */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** `child` lies strictly below `parent`: like `isWithin`, but `parent` itself is not inside it. */
export function isStrictlyWithin(parent: string, child: string): boolean {
  return path.relative(parent, child) !== '' && isWithin(parent, child);
}
