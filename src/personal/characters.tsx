import { useEffect, useState, type MouseEvent } from "react";
import { str, type RecordRow } from "./api";

export interface CharacterLayer {
  d: string;
  opacity?: number;
}

export interface CharacterDef {
  id: string;
  label: string;
  body: string;
  shade: string;
  light: string;
  paints?: CharacterLayer[];
  eyes: [number, number, number, number];
  eyeRx?: number;
  eyeRy?: number;
}

export const CHARACTERS: Record<string, CharacterDef> = {
  whale: {
    id: "whale",
    label: "鲸鱼",
    body: "M3 16 C3 8 9 4 16 4 C22 4 27 8 27 14 C28.5 12.5 30.5 10.5 31 9 C31.3 12 30.3 15 28.5 16.5 C30 18 31 20 31 22 C29.5 21 27.8 20 26.5 19.5 C24.5 24.5 20.5 28 15 28 C8 28 3 23 3 16 Z",
    shade: "M4 18 C4 24 8.5 28 15 28 C20.5 28 24.5 24.5 26.5 19.5 C22 22 10 22 4 18 Z",
    light: "M7 10 C9.5 6.5 14 5.5 19 6.5 C16 8 10.5 9.5 7 10 Z",
    paints: [
      { d: "M6 19 C9.5 22.5 18.5 22.5 23 19.5 C21.5 24 18 26.5 14 26.5 C9.2 26.5 6.3 23.2 6 19 Z", opacity: 0.45 },
      { d: "M7.8 21.3 C10.8 23.5 16.5 23.6 20 21.5", opacity: 0.35 },
    ],
    eyes: [11.5, 15, 19.5, 15],
  },
  star: {
    id: "star",
    label: "星芒",
    body: "M16 1.8 C17.8 1.8 19.8 7.5 21.2 8.6 C22.6 9.6 28.6 9.4 29.2 11.1 C29.8 12.8 24.8 16.2 24.3 17.9 C23.8 19.6 25.9 25.3 24.4 26.4 C22.9 27.5 18.2 23.8 16 23.8 C13.8 23.8 9.1 27.5 7.6 26.4 C6.1 25.3 8.2 19.6 7.7 17.9 C7.2 16.2 2.2 12.8 2.8 11.1 C3.4 9.4 9.4 9.6 10.8 8.6 C12.2 7.5 14.2 1.8 16 1.8 Z",
    shade: "M7.6 26.4 C9.1 27.5 13.8 23.8 16 23.8 C18.2 23.8 22.9 27.5 24.4 26.4 C25.5 25.6 24.4 21.8 24.3 19.5 C19.5 22 12.5 22 7.7 19.5 C7.6 21.8 6.5 25.6 7.6 26.4 Z",
    light: "M16 3.5 C14.7 3.5 13.1 7.8 11.8 8.8 C10.8 9.5 6.8 9.5 5.2 10.3 C10 11.5 15.5 10.5 19.5 8 C18.3 6.2 17 3.5 16 3.5 Z",
    paints: [
      { d: "M9 17.5 A2 1.3 0 1 0 13 17.5 A2 1.3 0 1 0 9 17.5 Z M19 17.5 A2 1.3 0 1 0 23 17.5 A2 1.3 0 1 0 19 17.5 Z", opacity: 0.45 },
    ],
    eyes: [12, 15, 20, 15],
  },
  moon: {
    id: "moon",
    label: "新月",
    body: "M19.5 2.5 C10.5 2.5 3.5 9.5 3.5 18 C3.5 25 9.5 29.5 17.5 29.5 C24.5 29.5 29.5 25 29.5 20.5 C29.5 18.8 27.8 18 26.2 19 C24.2 20.2 21.5 20.5 19 19.5 C15 18 13.5 13.5 15.5 9.5 C16.7 7.2 19 5.8 21 5 C22.5 4.3 22 2.5 19.5 2.5 Z",
    shade: "M4.5 20 C5.8 25.8 11 29.5 17.5 29.5 C24.5 29.5 29.5 25 29.5 20.5 C29.5 19.5 28.8 18.8 27.8 18.8 C24.5 23.5 13 24.5 4.5 20 Z",
    light: "M7 13 C7.8 8.2 12 4.5 17.5 3.8 C14.5 6.5 11.5 10.5 7 13 Z",
    paints: [
      { d: "M24 7 L25 9.5 L27.5 10.5 L25 11.5 L24 14 L23 11.5 L20.5 10.5 L23 9.5 Z M27 14 A1 1 0 1 0 29 14 A1 1 0 1 0 27 14 Z", opacity: 0.85 },
    ],
    eyes: [9.5, 16, 15.5, 17.5],
  },
  gumdrop: {
    id: "gumdrop",
    label: "软糖",
    body: "M16 3 C23.5 3 28.5 10.5 29 19.5 C29.5 26 25 29 16 29 C7 29 2.5 26 3 19.5 C3.5 10.5 8.5 3 16 3 Z",
    shade: "M3.2 21 C3.5 26.5 7.8 29 16 29 C24.2 29 28.5 26.5 28.8 21 C23.5 24 8.5 24 3.2 21 Z",
    light: "M10 6.5 C12.5 4.5 16.5 4.2 20 5.5 C17 7.2 12.8 8 10 6.5 Z",
    paints: [
      { d: "M7 18.5 A2.2 1.4 0 1 0 11.4 18.5 A2.2 1.4 0 1 0 7 18.5 Z M20.6 18.5 A2.2 1.4 0 1 0 25 18.5 A2.2 1.4 0 1 0 20.6 18.5 Z", opacity: 0.45 },
    ],
    eyes: [11.5, 16, 20.5, 16],
  },
  bunny: {
    id: "bunny",
    label: "雪兔",
    body: "M10.5 2 C8.5 2 7.5 4.5 7.8 9.5 C8 11.8 8.3 13 8.3 13 C5.2 15.2 4 18.5 4 21.8 C4 26.8 8.8 29.5 16 29.5 C23.2 29.5 28 26.8 28 21.8 C28 18.5 26.8 15.2 23.7 13 C23.7 13 24 11.8 24.2 9.5 C24.5 4.5 23.5 2 21.5 2 C19.5 2 18.5 5 18.2 10.8 C17.5 10.6 16.8 10.5 16 10.5 C15.2 10.5 14.5 10.6 13.8 10.8 C13.5 5 12.5 2 10.5 2 Z",
    shade: "M4.3 22.8 C5 27.2 9.5 29.5 16 29.5 C22.5 29.5 27 27.2 27.7 22.8 C22.5 25.5 9.5 25.5 4.3 22.8 Z",
    light: "M10.5 3.5 C9.6 3.5 9.2 5.8 9.4 9.8 C10.4 9.8 11.2 9.8 12 9.8 C11.8 5.8 11.4 3.5 10.5 3.5 Z M21.5 3.5 C20.6 3.5 20.2 5.8 20 9.8 C20.8 9.8 21.6 9.8 22.6 9.8 C22.8 5.8 22.4 3.5 21.5 3.5 Z",
    paints: [
      { d: "M10.5 4.2 C10 4.2 9.7 6 9.9 9.5 C10.5 9.5 11 9.5 11.5 9.5 C11.4 6 11 4.2 10.5 4.2 Z M21.5 4.2 C21 4.2 20.6 6 20.5 9.5 C21 9.5 21.5 9.5 22.1 9.5 C22.3 6 22 4.2 21.5 4.2 Z", opacity: 0.45 },
      { d: "M7.5 21 A2.1 1.3 0 1 0 11.7 21 A2.1 1.3 0 1 0 7.5 21 Z M20.3 21 A2.1 1.3 0 1 0 24.5 21 A2.1 1.3 0 1 0 20.3 21 Z", opacity: 0.4 },
    ],
    eyes: [11.5, 18.5, 20.5, 18.5],
  },
  kitty: {
    id: "kitty",
    label: "灵猫",
    body: "M5 5.5 C4.2 5.5 3.8 6.3 4 12 C4.1 14.5 3.5 17 3.5 20 C3.5 26 8.5 29 16 29 C23.5 29 28.5 26 28.5 20 C28.5 17 27.9 14.5 28 12 C28.2 6.3 27.8 5.5 27 5.5 C26.2 5.5 23 8.5 21 10.5 C19.4 10 17.8 9.8 16 9.8 C14.2 9.8 12.6 10 11 10.5 C9 8.5 5.8 5.5 5 5.5 Z",
    shade: "M3.8 21.5 C4.5 26.5 9.2 29 16 29 C22.8 29 27.5 26.5 28.2 21.5 C23 24.5 9 24.5 3.8 21.5 Z",
    light: "M10.5 12 C13.5 10.8 18.5 10.8 21.5 12 C18.5 13 13.5 13 10.5 12 Z",
    paints: [
      { d: "M5.8 7.8 L6 12.2 L9.5 10.5 Z M26.2 7.8 L26 12.2 L22.5 10.5 Z", opacity: 0.42 },
      { d: "M14.8 11 L16 14 L17.2 11 Z", opacity: 0.3 },
    ],
    eyes: [11, 18, 21, 18],
  },
  beacon: {
    id: "beacon",
    label: "信标",
    body: "M16 1.5 A2.2 2.2 0 1 0 16 5.9 A2.2 2.2 0 1 0 16 1.5 Z M14.8 5.5 L17.2 5.5 L17.6 9.5 L14.4 9.5 Z M16 9 C24 9 28.5 13 28.5 20 C28.5 26.2 24 29 16 29 C8 29 3.5 26.2 3.5 20 C3.5 13 8 9 16 9 Z",
    shade: "M3.8 21.5 C4.5 26.5 8.8 29 16 29 C23.2 29 27.5 26.5 28.2 21.5 C23 24.2 9 24.2 3.8 21.5 Z",
    light: "M16 1.8 A1.6 1.6 0 1 0 16 5 A1.6 1.6 0 1 0 16 1.8 Z M9 12 C12 10.3 18 10.3 22 11.8 C18 13 12.5 13 9 12 Z",
    paints: [
      { d: "M7 15 C7 13.2 10.5 12.3 16 12.3 C21.5 12.3 25 13.2 25 15 C25 20.5 21.5 22 16 22 C10.5 22 7 20.5 7 15 Z", opacity: 0.32 },
      { d: "M16 2 A1.5 1.5 0 1 0 16 5 A1.5 1.5 0 1 0 16 2 Z", opacity: 0.65 },
    ],
    eyes: [11.5, 17.5, 20.5, 17.5],
  },
  acorn: {
    id: "acorn",
    label: "橡果",
    body: "M14.8 2 C14.8 1.3 17.2 1.3 17.2 2 L17.5 4.8 C24.5 5.2 29 8.8 29 13 C29 14.2 28 14.8 26.8 14.8 C26.5 22.8 22.2 29.5 16 29.5 C9.8 29.5 5.5 22.8 5.2 14.8 C4 14.8 3 14.2 3 13 C3 8.8 7.5 5.2 14.5 4.8 Z",
    shade: "M3 12.5 C3 14 4 14.8 5.5 14.8 L26.5 14.8 C28 14.8 29 14 29 12.5 C22 14 10 14 3 12.5 Z M6.5 21.5 C8 26.5 11.5 29.5 16 29.5 C20.5 29.5 24 26.5 25.5 21.5 C21 24 11 24 6.5 21.5 Z",
    light: "M8 8 C11 6 17 5.5 22 6.8 C17.5 8.2 12 8.8 8 8 Z",
    paints: [
      { d: "M3 13 C3 8.8 7.5 5.2 14.5 4.8 L14.8 2 C14.8 1.3 17.2 1.3 17.2 2 L17.5 4.8 C24.5 5.2 29 8.8 29 13 C29 14.2 28 14.8 26.5 14.8 L5.5 14.8 C4 14.8 3 14.2 3 13 Z", opacity: 0.42 },
    ],
    eyes: [11.5, 19.5, 20.5, 19.5],
  },
  wave: {
    id: "wave",
    label: "海浪",
    body: "M3 17 C3 9 8.5 3.5 16 3.5 C23.5 3.5 29 9 29 17 C29 24.5 26 28.5 23 28.5 C20.8 28.5 19.8 26 18.2 26 C16.6 26 17.4 28.5 16 28.5 C14.6 28.5 15.4 26 13.8 26 C12.2 26 11.2 28.5 9 28.5 C6 28.5 3 24.5 3 17 Z",
    shade: "M3.2 19 C3.8 25 6.3 28.5 9 28.5 C11.2 28.5 12.2 26 13.8 26 C15.4 26 14.6 28.5 16 28.5 C17.4 28.5 16.6 26 18.2 26 C19.8 26 20.8 28.5 23 28.5 C25.7 28.5 28.2 25 28.8 19 C23 22 9 22 3.2 19 Z",
    light: "M8 9 C10.5 6 15 5 19.5 6 C16 7.5 11.5 8.5 8 9 Z",
    paints: [
      { d: "M7.5 16.5 A2 1.3 0 1 0 11.5 16.5 A2 1.3 0 1 0 7.5 16.5 Z M20.5 16.5 A2 1.3 0 1 0 24.5 16.5 A2 1.3 0 1 0 20.5 16.5 Z", opacity: 0.45 },
    ],
    eyes: [11.5, 14, 20.5, 14],
  },
  squircle: {
    id: "squircle",
    label: "方糖",
    body: "M16 3 C25.5 3 29 6.5 29 16 C29 25.5 25.5 29 16 29 C6.5 29 3 25.5 3 16 C3 6.5 6.5 3 16 3 Z",
    shade: "M3.2 19 C3.8 26 7.2 29 16 29 C24.8 29 28.2 26 28.8 19 C23.5 22.5 8.5 22.5 3.2 19 Z",
    light: "M7 6.5 C10 4.8 22 4.8 25 6.5 C21 8 11 8 7 6.5 Z",
    paints: [
      { d: "M7 17.5 A2.1 1.3 0 1 0 11.2 17.5 A2.1 1.3 0 1 0 7 17.5 Z M20.8 17.5 A2.1 1.3 0 1 0 25 17.5 A2.1 1.3 0 1 0 20.8 17.5 Z", opacity: 0.42 },
    ],
    eyes: [11.5, 15, 20.5, 15],
  },
};

export const CHARACTER_LIST = Object.values(CHARACTERS);

export interface InkDef {
  id: string;
  label: string;
  stops: [string, string];
  solid: string;
  soft: string;
}

export const INKS: Record<string, InkDef> = {
  deepseek: { id: "deepseek", label: "深海蓝", stops: ["#6d8cff", "#3d5afe"], solid: "#4d6bfe", soft: "rgba(77, 107, 254, 0.12)" },
  violet:   { id: "violet",   label: "星云紫", stops: ["#a78bfa", "#7c3aed"], solid: "#8b5cf6", soft: "rgba(139, 92, 246, 0.12)" },
  amber:    { id: "amber",    label: "琥珀金", stops: ["#fbbf24", "#ea580c"], solid: "#f59e0b", soft: "rgba(245, 158, 11, 0.12)" },
  mint:     { id: "mint",     label: "薄荷绿", stops: ["#34d399", "#059669"], solid: "#10b981", soft: "rgba(16, 185, 129, 0.12)" },
  rose:     { id: "rose",     label: "珊瑚粉", stops: ["#fb7185", "#e11d48"], solid: "#f43f5e", soft: "rgba(244, 63, 94, 0.12)" },
  sky:      { id: "sky",      label: "晴空蓝", stops: ["#38bdf8", "#0284c7"], solid: "#0ea5e9", soft: "rgba(14, 165, 233, 0.12)" },
  coral:    { id: "coral",    label: "落日橙", stops: ["#fb923c", "#dc2626"], solid: "#f97316", soft: "rgba(249, 115, 22, 0.12)" },
  teal:     { id: "teal",     label: "翡翠青", stops: ["#2dd4bf", "#0d9488"], solid: "#14b8a6", soft: "rgba(20, 184, 166, 0.12)" },
  indigo:   { id: "indigo",   label: "靛青蓝", stops: ["#818cf8", "#4f46e5"], solid: "#6366f1", soft: "rgba(99, 102, 241, 0.12)" },
  berry:    { id: "berry",    label: "浆果紫", stops: ["#e879f9", "#c026d3"], solid: "#d946ef", soft: "rgba(217, 70, 239, 0.12)" },
};

export const INK_LIST = Object.values(INKS);

export interface ThemeOption {
  id: string;
  label: string;
  accent: string;
  description: string;
}

export const THEMES: ThemeOption[] = [
  { id: "deepseek", label: "DeepSeek 经典蓝", accent: "#4d6bfe", description: "纯净留白与深海蓝强调" },
  { id: "paper", label: "Paper 暖纸橙", accent: "#d97757", description: "温润书页质感与陶土暖调" },
  { id: "moonlight", label: "Moonlight 极光蓝", accent: "#1e86ff", description: "通透玻璃感与清冷高光" },
  { id: "mono", label: "Mono 极简黑白", accent: "#141414", description: "纯粹黑白灰工业设计感" },
];

export interface BotLook {
  shape: CharacterDef;
  ink: InkDef;
  isSteward: boolean;
}

const PEER_PRESETS: Array<[string, string]> = [
  ["star", "amber"],
  ["moon", "violet"],
  ["gumdrop", "mint"],
  ["bunny", "rose"],
  ["kitty", "sky"],
  ["beacon", "coral"],
  ["acorn", "teal"],
  ["wave", "indigo"],
  ["squircle", "berry"],
];

function getCustomLookMap(): Record<string, { shape?: string; ink?: string }> {
  try {
    return JSON.parse(localStorage.getItem("nexbot.botLooks") || "{}") as Record<string, { shape?: string; ink?: string }>;
  } catch {
    return {};
  }
}

export function saveBotCustomLook(botId: string, look: { shape?: string; ink?: string }) {
  const current = getCustomLookMap();
  current[botId] = { ...current[botId], ...look };
  localStorage.setItem("nexbot.botLooks", JSON.stringify(current));
}

export function lookOf(bot?: RecordRow, allBots?: RecordRow[]): BotLook {
  const id = str(bot?.id);
  const name = str(bot?.name);
  const custom = id ? getCustomLookMap()[id] : undefined;
  const isSteward = Boolean(
    name.includes("秘书") ||
    name.includes("管家") ||
    name.toLowerCase().includes("steward") ||
    (allBots?.length && allBots[0]?.id === id)
  );

  if (custom?.shape && CHARACTERS[custom.shape] && custom?.ink && INKS[custom.ink]) {
    return { shape: CHARACTERS[custom.shape], ink: INKS[custom.ink], isSteward };
  }

  if (isSteward) {
    return {
      shape: CHARACTERS[custom?.shape ?? "whale"] ?? CHARACTERS.whale,
      ink: INKS[custom?.ink ?? "deepseek"] ?? INKS.deepseek,
      isSteward: true,
    };
  }

  if (/research|研究|调研|搜索/i.test(name)) {
    return {
      shape: CHARACTERS[custom?.shape ?? "beacon"] ?? CHARACTERS.beacon,
      ink: INKS[custom?.ink ?? "violet"] ?? INKS.violet,
      isSteward: false,
    };
  }
  if (/write|写作|撰稿|文案|编辑/i.test(name)) {
    return {
      shape: CHARACTERS[custom?.shape ?? "star"] ?? CHARACTERS.star,
      ink: INKS[custom?.ink ?? "amber"] ?? INKS.amber,
      isSteward: false,
    };
  }
  if (/code|开发|工程|编程/i.test(name)) {
    return {
      shape: CHARACTERS[custom?.shape ?? "kitty"] ?? CHARACTERS.kitty,
      ink: INKS[custom?.ink ?? "mint"] ?? INKS.mint,
      isSteward: false,
    };
  }

  let hash = 0;
  for (const ch of id || name || "bot") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [defaultShape, defaultInk] = PEER_PRESETS[hash % PEER_PRESETS.length];
  return {
    shape: CHARACTERS[custom?.shape ?? defaultShape] ?? CHARACTERS.gumdrop,
    ink: INKS[custom?.ink ?? defaultInk] ?? INKS.mint,
    isSteward: false,
  };
}

export function BotMark({ size = 28 }: { size?: number }) {
  const whale = CHARACTERS.whale;
  const [x1, y1, x2, y2] = whale.eyes;
  return (
    <span className="brand-mark ds-brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id="nexbot-brand-grad" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6d8cff" />
            <stop offset="100%" stopColor="#3d5afe" />
          </linearGradient>
        </defs>
        <path d={whale.body} fill="url(#nexbot-brand-grad)" />
        <path d={whale.shade} fill="#000" fillOpacity="0.16" />
        <path d={whale.light} fill="#fff" fillOpacity="0.32" />
        {whale.paints?.map((p, idx) => (
          <path key={idx} d={p.d} fill="#fff" fillOpacity={p.opacity ?? 0.4} />
        ))}
        <rect x={x1 - 1.3} y={y1 - 2.2} width={2.6} height={4.4} rx={1.3} fill="#fff" />
        <rect x={x2 - 1.3} y={y2 - 2.2} width={2.6} height={4.4} rx={1.3} fill="#fff" />
      </svg>
    </span>
  );
}

export function Avatar({
  bot,
  allBots,
  large = false,
  size,
  interactive = false,
  working = false,
}: {
  bot?: RecordRow;
  allBots?: RecordRow[];
  large?: boolean;
  size?: number;
  interactive?: boolean;
  working?: boolean;
}) {
  const [happy, setHappy] = useState(false);
  const [blink, setBlink] = useState(false);
  const [gaze, setGaze] = useState<[number, number]>([0, 0]);
  const look = lookOf(bot, allBots);
  const px = size ?? (large ? 64 : 36);
  const [x1, y1, x2, y2] = look.shape.eyes;
  const rx = look.shape.eyeRx ?? 1.45;
  const ry = look.shape.eyeRy ?? 2.35;
  const gradId = `bot-grad-${str(bot?.id || bot?.name || "default").replace(/[^a-zA-Z0-9_-]/g, "")}-${look.ink.id}-${px}`;

  useEffect(() => {
    if (!large && !interactive && !working) return;
    const timer = setInterval(() => {
      setBlink(true);
      setTimeout(() => setBlink(false), 150);
    }, 3600 + (px % 7) * 400);
    return () => clearInterval(timer);
  }, [large, interactive, working, px]);

  const handlePoke = (e: MouseEvent) => {
    if (!interactive && !large) return;
    e.stopPropagation();
    setHappy(true);
    setTimeout(() => setHappy(false), 950);
  };

  const handleMove = (e: MouseEvent<HTMLSpanElement>) => {
    if (!interactive && !large) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = Math.max(-1.4, Math.min(1.4, ((e.clientX - (rect.left + rect.width / 2)) / rect.width) * 3));
    const dy = Math.max(-1.1, Math.min(1.1, ((e.clientY - (rect.top + rect.height / 2)) / rect.height) * 2.4));
    setGaze([dx, dy]);
  };

  return (
    <span
      aria-hidden="true"
      className={`avatar ds-avatar ${large ? "large" : ""} ${happy ? "is-happy" : ""} ${working ? "is-working" : ""} ${interactive || large ? "is-interactive" : ""}`}
      style={{ width: px, height: px }}
      onClick={handlePoke}
      onMouseMove={handleMove}
      onMouseLeave={() => setGaze([0, 0])}
      title={interactive || large ? "点我互动一下" : undefined}
    >
      <svg width={px} height={px} viewBox="0 0 32 32" fill="none" className="ds-avatar-svg">
        <defs>
          <linearGradient id={gradId} x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={look.ink.stops[0]} />
            <stop offset="100%" stopColor={look.ink.stops[1]} />
          </linearGradient>
        </defs>
        <g className="ds-avatar-body">
          <path d={look.shape.body} fill={`url(#${gradId})`} />
          <path d={look.shape.shade} fill="#000" fillOpacity="0.16" />
          <path d={look.shape.light} fill="#fff" fillOpacity="0.32" />
          {look.shape.paints?.map((p, idx) => (
            <path key={idx} d={p.d} fill="#fff" fillOpacity={p.opacity ?? 0.42} />
          ))}
        </g>
        <g className="ds-avatar-eyes" transform={`translate(${gaze[0].toFixed(2)}, ${gaze[1].toFixed(2)})`}>
          {happy ? (
            <>
              <path
                d={`M${x1 - 2.1} ${y1 + 0.5} Q${x1} ${y1 - 2.2} ${x1 + 2.1} ${y1 + 0.5}`}
                stroke="#fff"
                strokeWidth="2.1"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d={`M${x2 - 2.1} ${y2 + 0.5} Q${x2} ${y2 - 2.2} ${x2 + 2.1} ${y2 + 0.5}`}
                stroke="#fff"
                strokeWidth="2.1"
                strokeLinecap="round"
                fill="none"
              />
            </>
          ) : blink ? (
            <>
              <rect x={x1 - rx * 1.1} y={y1 - 0.45} width={rx * 2.2} height={0.9} rx={0.45} fill="#fff" />
              <rect x={x2 - rx * 1.1} y={y2 - 0.45} width={rx * 2.2} height={0.9} rx={0.45} fill="#fff" />
            </>
          ) : (
            <>
              <rect x={x1 - rx} y={y1 - ry} width={rx * 2} height={ry * 2} rx={rx} fill="#fff" />
              <rect x={x2 - rx} y={y2 - ry} width={rx * 2} height={ry * 2} rx={rx} fill="#fff" />
            </>
          )}
        </g>
      </svg>
      {look.isSteward ? (
        <span className="ds-steward-crown" title="主理秘书">
          <svg width={large ? 16 : 12} height={large ? 16 : 12} viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7.2" fill="#fbbf24" stroke="#fff" strokeWidth="1.5" />
            <path d="M8 3.6L9.2 6.3L12.1 6.6L9.9 8.5L10.6 11.4L8 9.8L5.4 11.4L6.1 8.5L3.9 6.6L6.8 6.3L8 3.6Z" fill="#fff" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}
