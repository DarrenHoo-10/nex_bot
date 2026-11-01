import { useSyncExternalStore } from 'react';
import { parseAppearance, type Appearance } from '../../../shared/personal-appearance';
import type { RecordRow } from '../api';
import { appearanceOf } from './appearance';
import { characterIds, type CharacterId } from './character-catalog';

export type PreviewAppearance = Appearance | {kind:'q';id:CharacterId};
export const localAvatarPreview = import.meta.env.VITE_Q_AVATAR === '1';
const eventName = 'nex-local-avatar-change';
const key = (bot?: RecordRow) => `nexbot.local-avatar.v1:${String(bot?.id ?? '')}`;
function stored(bot?: RecordRow) { try { return localStorage.getItem(key(bot)); } catch { return null; } }
export function resolvePreviewAppearance(raw: string | null, fallback: Appearance, first: boolean): PreviewAppearance {
  if (raw) try {
    const value = JSON.parse(raw);
    if (value?.kind === 'q' && characterIds.includes(value.id)) return {kind:'q',id:value.id};
    return parseAppearance(value);
  } catch { /* Ignore invalid local preferences. */ }
  return first ? {kind:'q',id:'blue-maid'} : fallback;
}
export function localAppearanceOf(bot: RecordRow, firstId: string): PreviewAppearance {
  const fallback = appearanceOf(bot,firstId);
  return resolvePreviewAppearance(stored(bot),fallback,bot.id === firstId || fallback.kind === 'graphic' && fallback.id === 'secretary-01');
}
function subscribe(listener: () => void) {
  window.addEventListener(eventName,listener); window.addEventListener('storage',listener);
  return () => {window.removeEventListener(eventName,listener);window.removeEventListener('storage',listener);};
}
export function useLocalAppearance(bot?: RecordRow, firstId = ''): PreviewAppearance | undefined {
  const raw = useSyncExternalStore(subscribe,() => stored(bot),() => null);
  if (!localAvatarPreview || !bot) return undefined;
  const fallback = appearanceOf(bot,firstId);
  return resolvePreviewAppearance(raw,fallback,bot.id === firstId || fallback.kind === 'graphic' && fallback.id === 'secretary-01');
}
export function saveLocalAppearance(bot: RecordRow, appearance: PreviewAppearance) {
  localStorage.setItem(key(bot),JSON.stringify(appearance));
  window.dispatchEvent(new Event(eventName));
}
