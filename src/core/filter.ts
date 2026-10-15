import type { SpaceNode } from './types';

export type TagMatchMode = 'any' | 'all';

export interface TagFilter {
  tagIds: string[];
  mode: TagMatchMode;
}

/** Empty filter matches everything. */
export function matchesFilter(n: SpaceNode, f: TagFilter): boolean {
  if (f.tagIds.length === 0) return true;
  return f.mode === 'any' ? f.tagIds.some((t) => n.tags.includes(t)) : f.tagIds.every((t) => n.tags.includes(t));
}
