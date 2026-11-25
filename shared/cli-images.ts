export const CLI_IMAGE_PREFIX = "/api/cli-agents/images/";
const imageId = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
export const cliImageId = (path: string) => new RegExp(`^${CLI_IMAGE_PREFIX}(${imageId})$`).exec(path)?.[1];

/** Only the exact image links emitted by NexAgent are rewritten. */
export function mapCliImageLinks(text: string, href: (id: string, original: string) => string): string {
  return text.replace(new RegExp(`(!\\[[^\\]\\n]*\\]\\()((?:https?://[^/\\s()]+)?${CLI_IMAGE_PREFIX}(${imageId})(?:\\?ticket=[0-9]+\\.[0-9a-f]{64})?)\\)`, "g"),
    (_, before: string, original: string, id: string) => before + href(id, original) + ")");
}

export function privateCliImageLinks(text: string): string {
  return text.replace(new RegExp(`https?://[^/\\s()"'<>]+${CLI_IMAGE_PREFIX}(${imageId})\\?ticket=[0-9]+\\.[0-9a-f]{64}`, "g"), CLI_IMAGE_PREFIX + "$1");
}

export const cliImageReference = (name: string, path: string) => `![${name.replace(/[\\[\]\\\\\r\n]/g, "_")}](${path})`;
