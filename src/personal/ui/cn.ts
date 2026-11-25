import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional Tailwind CSS v4 class names cleanly. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
