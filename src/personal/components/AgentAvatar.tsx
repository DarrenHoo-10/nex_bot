import type { Avatar as CharacterAvatar } from "../characters";
import type { ComponentProps } from "react";
import { avatarForBot } from "../avatars/preferences";

export function AgentAvatar(props: ComponentProps<typeof CharacterAvatar>) {
  const avatar = avatarForBot(String(props.bot?.id ?? "")), size = props.size ?? (props.large ? 64 : 36);
  return <span className={`agent-glyph portrait-avatar ${props.working ? "is-working" : ""}`} data-avatar={avatar.id} style={{ width: size, height: size }} aria-hidden="true"><img src={avatar.src} alt="" width={size} height={size} draggable={false}/>{props.working && <i/>}</span>;
}
