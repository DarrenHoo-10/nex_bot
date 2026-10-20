import { sanitize, type Schema } from "hast-util-sanitize";
import type { Element, Root, RootContent } from "hast";

// Keep this policy aligned with NexMarkdown/StaticHTML.swift.
export const staticHTMLTags = "a b strong i em s del u mark small sub sup span div p br hr h1 h2 h3 h4 h5 h6 blockquote pre code kbd ul ol li dl dt dd table caption thead tbody tfoot tr th td".split(" ");
const blocked = "script style iframe frame frameset object embed svg math template noscript form textarea select option button audio video canvas link meta base".split(" ");
const schema: Schema = {
  tagNames: [...staticHTMLTags, "input", "img"],
  strip: blocked,
  attributes: {
    "*": ["title", "style"], a: ["href"], img: ["src", "alt"],
    input: [["type", "checkbox"], "checked", "disabled"],
    ol: ["start"], th: ["align", "colSpan", "rowSpan"], td: ["align", "colSpan", "rowSpan"],
    code: [["className", /^language-[\w-]+$/]],
    li: [["className", "task-list-item"]], ul: [["className", "contains-task-list"]],
  },
  protocols: { href: ["http", "https"], src: [] },
};

export function staticHTMLStyle(style: string): string {
  return style.split(";").flatMap((declaration) => {
    const [rawName, ...rest] = declaration.split(":"), name = rawName.trim().toLowerCase(), value = rest.join(":").trim().toLowerCase();
    let valid = false;
    if (name === "color" || name === "background-color") valid = /^(#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]{1,20}|rgba?\([\d.,%\s]+\))$/.test(value);
    if (name === "text-align") valid = /^(left|center|right|justify)$/.test(value);
    if (name === "font-weight") valid = /^(normal|bold|bolder|lighter|[1-9]00)$/.test(value);
    if (name === "font-style") valid = /^(normal|italic|oblique)$/.test(value);
    if (name === "text-decoration") valid = /^(none|underline|line-through)$/.test(value);
    if (name === "font-size") valid = /^(1[0-9]|2[0-9]|3[0-2])px$/.test(value);
    if (name === "white-space") valid = /^(normal|pre|pre-wrap|pre-line)$/.test(value);
    if (name === "border-collapse") valid = /^(collapse|separate)$/.test(value);
    return valid ? [`${name}:${value}`] : [];
  }).join(";");
}

export function staticHTMLLink(value: string): boolean {
  if (/^\/api\/attachments\/[a-zA-Z0-9-]+$/.test(value)) return true;
  // Reject URL control characters rather than allowing browser normalization.
  // eslint-disable-next-line no-control-regex
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}

export function rehypeStaticHTML() {
  return (tree: Root): Root => {
    const clean = (children: RootContent[]): RootContent[] => children.flatMap<RootContent>((node) => {
      if (node.type !== "element") return [node];
      if (blocked.includes(node.tagName)) return [];
      const props = node.properties;
      if (typeof props.style === "string") props.style = staticHTMLStyle(props.style);
      if (typeof props.href === "string" && !staticHTMLLink(props.href)) delete props.href;
      if (node.tagName === "img" && !(typeof props.src === "string" && /^\/api\/attachments\/[a-zA-Z0-9-]+$/.test(props.src))) {
        return [{ type: "text", value: String(props.alt ?? "图片") }];
      }
      if (node.tagName === "input") {
        if (props.type !== "checkbox") return [];
        props.disabled = true;
      }
      for (const name of ["colSpan", "rowSpan"]) if (name in props) props[name] = Math.max(1, Math.min(100, Number(props[name]) || 1));
      node.children = clean(node.children) as Element["children"];
      return [node];
    });
    tree.children = clean(tree.children);
    return sanitize(tree, schema) as Root;
  };
}
