/** Publishes the real viewport height as `--nex-vh`; see scripts/android-viewport.mjs for why. */
export function installViewportHeight(host: Pick<Window, "innerHeight" | "addEventListener"> & { visualViewport?: Pick<VisualViewport, "height" | "addEventListener"> | null },
  root: Pick<HTMLElement, "style">) {
  const apply = () => {
    const height = host.visualViewport?.height || host.innerHeight;
    if (height > 0) root.style.setProperty("--nex-vh", `${height / 100}px`);
  };
  apply();
  host.addEventListener("resize", apply);
  host.visualViewport?.addEventListener("resize", apply);
  // The first layout can finish after the module runs.
  host.addEventListener("load", apply);
}
