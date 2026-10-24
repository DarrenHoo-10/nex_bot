export const companionShapes = ["soft", "bean", "pebble", "bud"] as const;
export const companionColors = ["teal", "ink", "blue", "clay", "plum"] as const;
export const portraitIds = ["fox", "owl", "cat", "bear", "rabbit", "dog", "panda", "koala", "tiger", "deer", "penguin", "seal", "otter", "octopus", "frog", "robot", "astronaut", "star", "cloud", "sprout"] as const;
export const graphicAvatarIds = ["female-03", "female-04", "female-05", "female-06", "female-07", "female-12", "male-01", "male-02", "male-03", "male-04", "male-05", "male-06"] as const;
export type GraphicAvatarId = typeof graphicAvatarIds[number];
export type Appearance = { kind: "companion"; shape: typeof companionShapes[number]; color: typeof companionColors[number] } | { kind: "portrait"; id: typeof portraitIds[number] } | { kind: "graphic"; id: GraphicAvatarId };
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("头像配置无效");
  const data = value as Record<string, unknown>;
  if (data.kind === "companion" && companionShapes.some((s) => s === data.shape) && companionColors.some((c) => c === data.color)) return { kind: "companion", shape: data.shape as typeof companionShapes[number], color: data.color as typeof companionColors[number] };
  if (data.kind === "portrait" && portraitIds.some((id) => id === data.id)) return { kind: "portrait", id: data.id as typeof portraitIds[number] };
  if (data.kind === "graphic" && graphicAvatarIds.some((id) => id === data.id)) return { kind: "graphic", id: data.id as GraphicAvatarId };
  throw new Error("请选择有效的头像形状与颜色");
}
