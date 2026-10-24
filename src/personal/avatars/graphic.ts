import { graphicAvatarIds, type GraphicAvatarId } from "../../../shared/personal-appearance";
import { graphicAvatarData } from "../../../shared/personal-graphic-avatars";
import female0347 from "./graphic/female-03-04-07.png?url";
import female05612 from "./graphic/female-05-06-12.png?url";
import male from "./graphic/male-01-06.png?url";

const sheets = { "female-03-04-07": female0347, "female-05-06-12": female05612, "male-01-06": male };
function avatar(id: GraphicAvatarId) {
  const item = graphicAvatarData[id];
  return { ...item, sheet: { ...item.sheet, src: sheets[item.sheet.id as keyof typeof sheets] } };
}
export const graphicAvatars = Object.fromEntries(graphicAvatarIds.map(id => [id, avatar(id)])) as Record<GraphicAvatarId, ReturnType<typeof avatar>>;
export const GRAPHIC_AVATARS = graphicAvatarIds.map(id => ({ id, ...graphicAvatars[id] }));
