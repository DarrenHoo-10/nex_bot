import type { CSSProperties } from "react";
import type { GraphicAvatarId } from "../../../shared/personal-appearance";
import { graphicAvatars } from "../avatars/graphic";

export function GraphicPortrait({ id }: { id: GraphicAvatarId }) {
  const { sheet, crop, motion } = graphicAvatars[id];
  return <span className="graphic-avatar-frame" style={{ "--graphic-tempo": `${motion[0]}s`, "--graphic-tilt": `${motion[1]}deg`, "--graphic-lift": `${motion[2]}%` } as CSSProperties}>
    <svg viewBox={crop.join(" ")} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <image href={sheet.src} width={sheet.width} height={sheet.height}/>
    </svg>
  </span>;
}
