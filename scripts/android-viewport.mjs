/**
 * The Android WebView reports every vertical viewport unit (vh, dvh, svh, lvh) as 0 px while
 * widths and percentages are right, so anything sized with them collapses: the workspace
 * becomes 0 px tall and dialogs shrink to one row. `src/personal/android-viewport.ts` publishes
 * the real height as `--nex-vh`; this rewrites the stylesheet to use it.
 */
export function rewriteViewportUnits(css) {
  // Rewrite viewport height units only in declaration values (never inside escaped class selectors like `.max-h-\[90vh\]`).
  return css.replace(/(:[^;{}]+?)([;{}])/g, (_match, value, end) =>
    value.replace(/(?<![-\w\\])(\d*\.?\d+)(?:d|s|l)?vh\b/g, "calc(var(--nex-vh, 1vh) * $1)") + end,
  );
}

/** Vite plugin: rewrites viewport height units in both source CSS and bundled Tailwind utilities. */
export function androidViewportUnits() {
  return {
    name: "android-viewport-units",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      const rewritten = rewriteViewportUnits(code);
      return rewritten === code ? null : { code: rewritten, map: null };
    },
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type === "asset" && asset.fileName.endsWith(".css") && typeof asset.source === "string") {
          asset.source = rewriteViewportUnits(asset.source);
        }
      }
    },
  };
}
