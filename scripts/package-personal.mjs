// Compatibility command: Core is a service archive; desktop packages are shells.
if (!process.argv.includes("--client")) await import("./package-core.mjs");
else {
  if (process.platform !== "win32") throw new Error("Build the Windows thin shell on Windows");
  const { build } = await import("electron-builder");
  await build({ config: "electron-builder.client.yml", publish: "never" });
}
