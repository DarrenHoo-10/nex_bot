import type { ReactNode } from "react";
import { cn } from "./cn";

export type SemanticTone = "neutral" | "brand" | "success" | "warning" | "danger";

const dotColors: Record<SemanticTone, string> = {
  neutral: "bg-[var(--muted-foreground)]",
  brand: "bg-[var(--brand)] shadow-[0_0_0_3px_var(--brand-soft)]",
  success: "bg-[var(--success)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_20%,transparent)]",
  warning: "bg-[var(--warning)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--warning)_22%,transparent)]",
  danger: "bg-[var(--destructive)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_20%,transparent)]",
};

const badgeTones: Record<SemanticTone, string> = {
  neutral: "bg-[var(--secondary)] text-[var(--secondary-foreground)] border-transparent",
  brand: "bg-[var(--brand-soft)] text-[var(--brand-ink)] border-transparent",
  success: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-ink)] border-transparent",
  warning: "bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)] border-transparent",
  danger: "bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] text-[var(--destructive)] border-transparent",
};

export function StatusDot({ tone = "neutral", className }: { tone?: SemanticTone; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", dotColors[tone], className)} />;
}

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: SemanticTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[12px] font-medium leading-tight whitespace-nowrap",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
