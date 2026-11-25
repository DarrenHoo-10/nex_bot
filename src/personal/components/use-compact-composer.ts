import { useSyncExternalStore } from "react";
import { desktop } from "../api";

const compact = "(max-width: 720px)";
const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(compact);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getSnapshot = () => desktop?.platform === "android" || window.matchMedia(compact).matches;

export function useCompactComposer() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
