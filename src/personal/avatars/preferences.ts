import { AVATARS, type AvatarId } from "./index";

const key = "nexbot.avatarPortraits.v1";
function preferences(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch { return {}; }
}
export function avatarForBot(botId: string) {
  const saved = preferences()[botId];
  const custom = AVATARS.find((avatar) => avatar.id === saved);
  if (custom) return custom;
  let hash = 0;
  for (const char of botId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATARS[hash % AVATARS.length];
}
export function saveAvatar(botId: string, avatarId: AvatarId) {
  if (!botId || !AVATARS.some((avatar) => avatar.id === avatarId)) return;
  const values = preferences();
  values[botId] = avatarId;
  localStorage.setItem(key, JSON.stringify(values));
}
