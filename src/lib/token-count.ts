const trim = (value: number) => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ""));

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1_000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1_000) return formatTokens(n);
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000)}K`;
}
