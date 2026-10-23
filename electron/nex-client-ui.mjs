import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Optional local-only UI package. Normal thin-client releases omit this folder.
// Keep the original Core origin and session: only static assets are overridden.
export function installLocalUi(session, directory, getOrigin) {
  if (!existsSync(path.join(directory, "index.html"))) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
  const files = new Map();
  function collect(folder, prefix = "") {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix + item.name;
      if (item.isDirectory() && relative === "assets") collect(path.join(folder, item.name), "assets/");
      else if (item.isFile() && (relative.startsWith("assets/") || ["index.html", "personal.html", "app-icon.svg", "html-preview.html"].includes(relative))) {
        const type = types[path.extname(item.name)];
        if (!type) continue;
        let body = readFileSync(path.join(folder, item.name));
        const preview = relative === "html-preview.html";
        if (item.name.endsWith(".html") && !preview) body = Buffer.from(body.toString("utf8").replace("</head>", '<meta name="nexbot-ui-source" content="local"></head>'));
        files.set("/" + relative, { body, type, preview });
      }
    }
  }
  collect(directory);
  files.set("/", files.get("/index.html"));
  const handler = (request) => {
    const url = new URL(request.url);
    const file = request.method === "GET" && url.origin === getOrigin() ? files.get(url.pathname) : undefined;
    if (file) return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(file.preview ? { "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors 'self'" } : {}) } });
    return session.fetch(request, { bypassCustomProtocolHandlers: true });
  };
  session.protocol.handle("https", handler);
  session.protocol.handle("http", handler);
  return true;
}
