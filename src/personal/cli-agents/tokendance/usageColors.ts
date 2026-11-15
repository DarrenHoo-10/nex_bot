/** Shared palette for usage charts: models, skills, members, and unknown harnesses. */
export const USAGE_COLOR_POOL = [
  '#3B82C4',
  '#E07A3D',
  '#5B8C5A',
  '#8B5CF6',
  '#DB5A7A',
  '#2A9D8F',
  '#C9A227',
  '#4A6FA5',
  '#C45C26',
  '#6B4C9A',
  '#1B8A6B',
  '#D15B8F',
  '#3D6B8A',
  '#B86A2A',
  '#5C7A3A',
  '#7A4E6A',
] as const;

export function usageColor(key?: string | null): string {
  const raw = (key ?? '').trim() || 'unknown';
  let hash = 0;
  for (const ch of raw) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return USAGE_COLOR_POOL[hash % USAGE_COLOR_POOL.length];
}

export function usageColorAt(index: number): string {
  const size = USAGE_COLOR_POOL.length;
  return USAGE_COLOR_POOL[((index % size) + size) % size];
}

/** Assign sequential pool colors so adjacent members stay distinct. */
export function assignUsageColors(keys: readonly (string | null | undefined)[]): Map<string, string> {
  const assigned = new Map<string, string>();
  let index = 0;
  for (const key of keys) {
    const id = (key ?? '').trim() || 'unknown';
    if (!assigned.has(id)) {
      assigned.set(id, usageColorAt(index));
      index += 1;
    }
  }
  return assigned;
}
