/**
 * The Android WebView reports every vertical viewport unit (vh, dvh, svh, lvh) as 0 px while
 * widths and percentages are right, so anything sized with them collapses: the workspace
 * becomes 0 px tall and dialogs shrink to one row. `src/personal/android-viewport.ts` publishes
 * the real height as `--nex-vh`; this rewrites the stylesheet to use it.
 */
export function rewriteViewportUnits(css) {
  return css.replace(/(\d*\.?\d+)(?:d|s|l)?vh\b/g, "calc(var(--nex-vh, 1vh) * $1)");
}

/** Vite plugin: runs before Vite's own CSS handling so every imported stylesheet is covered. */
export function androidViewportUnits() {
  return {
    name: "android-viewport-units",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith(".css")) return null;
      const rewritten = rewriteViewportUnits(code);
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}
