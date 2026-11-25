import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--brand)] text-white border border-transparent shadow-[0_1px_2px_rgba(30,64,175,0.22),inset_0_1px_0_rgba(255,255,255,0.22)] hover:bg-[var(--brand-hover)] active:translate-y-px",
  secondary:
    "bg-[var(--card)] text-[var(--foreground)] border border-[var(--border-strong)] shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:bg-[var(--secondary)] hover:border-[var(--border-hover)]",
  ghost:
    "bg-transparent text-[var(--secondary-foreground)] border border-transparent hover:bg-[var(--wash)] hover:text-[var(--foreground)]",
  danger:
    "bg-[var(--destructive)] text-white border border-transparent shadow-[0_1px_2px_rgba(185,28,28,0.2)] hover:brightness-95 active:translate-y-px",
  icon:
    "bg-transparent text-[var(--muted-foreground)] border border-transparent hover:bg-[var(--wash)] hover:text-[var(--foreground)] rounded-full p-0",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[12px] rounded-[var(--radius-sm)] gap-1.5",
  md: "h-9 px-3.5 text-[13px] rounded-[var(--radius-md)] gap-2",
  lg: "h-11 px-5 text-[14px] rounded-[var(--radius-md)] gap-2",
};

const iconSizeClasses: Record<ButtonSize, string> = {
  sm: "size-7",
  md: "size-8",
  lg: "size-9",
};

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]",
        variantClasses[variant],
        variant === "icon" ? iconSizeClasses[size] : sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
