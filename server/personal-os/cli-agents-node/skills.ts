import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { SKILL_LIMIT, skillCommandName, type SkillOption } from "../../../shared/cli-agents.ts";

async function settings(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { return {}; }
}

/** Only names and frontmatter descriptions cross the device link. */
async function skillRow(directory: string, namespace: string): Promise<SkillOption | undefined> {
  const file = path.join(directory, "SKILL.md");
  try {
    if (!(await stat(file)).isFile()) return;
    const handle = await open(file, "r");
    let header: string;
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      header = buffer.toString("utf8", 0, bytesRead).replace(/^\uFEFF/, "");
    } finally { await handle.close(); }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(header);
    const fields = match ? parse(match[1]) : {};
    if (fields?.["user-invocable"] === false) return;
    const name = namespace + (typeof fields?.name === "string" && fields.name ? fields.name : path.basename(directory));
    if (!skillCommandName.test(name)) return;
    return { name, description: typeof fields?.description === "string" ? fields.description.trim().slice(0, 300) : "" };
  } catch { return; }
}

export async function claudeSkills(configDir: string, cwd: string) {
  const roots = new Map<string, string>();
  const parents: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    roots.set(path.join(dir, ".claude", "skills"), "");
    parents.push(dir);
    if (dir === path.dirname(dir)) break;
  }
  roots.set(path.join(configDir, "skills"), "");

  // Plugin skills use /plugin:skill. Scope project installs and respect local overrides.
  const installed = await settings(path.join(configDir, "plugins", "installed_plugins.json"));
  if (installed?.plugins) {
    const enabled = { ...(await settings(path.join(configDir, "settings.json")))?.enabledPlugins };
    for (const dir of [...parents].reverse()) {
      for (const file of ["settings.json", "settings.local.json"]) {
        Object.assign(enabled, (await settings(path.join(dir, ".claude", file)))?.enabledPlugins);
      }
    }
    for (const [id, entries] of Object.entries(installed.plugins)) {
      if (!enabled[id] || !Array.isArray(entries)) continue;
      const entry = entries.find(e => typeof e?.projectPath === "string" && parents.includes(path.resolve(e.projectPath))) ??
        entries.find(e => e && !e.projectPath);
      if (typeof entry?.installPath === "string") roots.set(path.join(entry.installPath, "skills"), id.split("@")[0] + ":");
    }
  }
  const skills = new Map<string, SkillOption>();
  for (const [root, namespace] of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const row = await skillRow(path.join(root, entry.name), namespace);
      if (row && !skills.has(row.name)) skills.set(row.name, row);
      if (skills.size === SKILL_LIMIT) break;
    }
    if (skills.size === SKILL_LIMIT) break;
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
