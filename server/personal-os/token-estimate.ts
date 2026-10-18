// Conservative offline estimate; provider receipts remain the usage authority.
// Kept independent of Core modules so strip-only worker processes can import it.
export function tokens(value: unknown): number {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  // Deliberately exclude the complete ASCII range, including control characters.
  // eslint-disable-next-line no-control-regex
  const wide = (s.match(/[^\x00-\x7f]/g) ?? []).length;
  return Math.ceil((s.length - wide) / 3 + wide * 1.5);
}
