import type { ComponentPropsWithoutRef } from "react";

type Props = ComponentPropsWithoutRef<"button"> & { tone?: "light" | "dark"; size?: "regular" | "compact" };

export function ConversationActionButton({ tone = "light", size = "regular", type = "button", className, ...props }: Props) {
  return <button {...props} type={type} data-tone={tone} data-size={size} className={className ? `conversation-action ${className}` : "conversation-action"}/>;
}
