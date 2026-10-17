export const companionShapes = ["soft", "bean", "pebble", "bud"] as const;
export const companionColors = ["teal", "ink", "blue", "clay", "plum"] as const;
export const portraitIds = ["fox", "owl", "cat", "bear", "rabbit", "dog", "panda", "koala", "tiger", "deer", "penguin", "seal", "otter", "octopus", "frog", "robot", "astronaut", "star", "cloud", "sprout"] as const;
export type Appearance = { kind: "companion"; shape: typeof companionShapes[number]; color: typeof companionColors[number] } | { kind: "portrait"; id: typeof portraitIds[number] };
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("头像配置无效");
  const data = value as Record<string, unknown>;
  if (data.kind === "companion" && companionShapes.some((s) => s === data.shape) && companionColors.some((c) => c === data.color)) return { kind: "companion", shape: data.shape as typeof companionShapes[number], color: data.color as typeof companionColors[number] };
  if (data.kind === "portrait" && portraitIds.some((id) => id === data.id)) return { kind: "portrait", id: data.id as typeof portraitIds[number] };
  throw new Error("请选择有效的头像形状与颜色");
}
