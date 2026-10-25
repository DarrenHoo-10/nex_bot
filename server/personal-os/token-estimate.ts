// Conservative offline estimate; provider receipts remain the usage authority.
// Kept independent of Core modules so strip-only worker processes can import it.
// Providers bill an image by its pixels, not its base64 length: a 1 MB photo is
// ~1.4M characters but at most ~1600 tokens (Anthropic) or ~1100 (OpenAI high).
export const IMAGE_TOKENS = 2000;
export function isImagePart(value: unknown): boolean {
  const type = value && typeof value === 'object' ? (value as { type?: unknown }).type : undefined;
  return type === 'image' || type === 'image_url' || type === 'input_image';
}
export function tokens(value: unknown): number {
  let images = 0;
  const s = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => {
    if (!isImagePart(item)) return item;
    images++;
    return null;
  }) ?? '';
  // Deliberately exclude the complete ASCII range, including control characters.
  // eslint-disable-next-line no-control-regex
  const wide = (s.match(/[^\x00-\x7f]/g) ?? []).length;
  return Math.ceil((s.length - wide) / 3 + wide * 1.5) + images * IMAGE_TOKENS;
}
