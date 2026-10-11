// Legacy boot does not import this module. Unset NEX_BACKEND stays legacy.
export type NexBackend = "legacy" | "personal-os";

export function resolveBackend(env: NodeJS.ProcessEnv): NexBackend {
  const raw = env.NEX_BACKEND;
  if (raw === undefined || raw === "" || raw === "legacy") return "legacy";
  if (raw === "personal-os") return "personal-os";
  throw new Error(`Unknown NEX_BACKEND: ${raw}`);
}
