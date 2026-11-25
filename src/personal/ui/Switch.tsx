import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  size?: "sm" | "md";
}

/** Unified NexBot bright-blue toggle switch. */
export function Switch({ size = "md", className, title, ...props }: SwitchProps) {
  const sm = size === "sm";
  return (
    <label
      title={title}
      className={cn(
        "relative inline-flex shrink-0 items-center cursor-pointer has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        className,
      )}
    >
      <input type="checkbox" role="switch" className="peer sr-only" {...props} />
      <span
        aria-hidden="true"
        className={cn(
          "relative rounded-full bg-[var(--switch-track)] transition-colors duration-150 peer-checked:bg-[var(--brand)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brand)] after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(15,23,42,0.28)] after:transition-transform after:duration-150",
          sm
            ? "h-[18px] w-[32px] after:size-[12px] peer-checked:after:translate-x-[14px]"
            : "h-[22px] w-[38px] after:size-[16px] peer-checked:after:translate-x-[16px]",
        )}
      />
    </label>
  );
}
