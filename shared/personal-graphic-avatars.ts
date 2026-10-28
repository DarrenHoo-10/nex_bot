import type { GraphicAvatarId } from "./personal-appearance";

interface GraphicSheet { id: string; width: number; height: number }
interface GraphicAvatar {
  description: string;
  sheet: GraphicSheet;
  crop: readonly [number, number, number, number];
  // Seconds, tilt in degrees, and lift as a percentage of the avatar size.
  motion: readonly [number, number, number];
}
const revisedFemale = { id: "female-03-04-07", width: 1958, height: 803 };
const expressiveFemale = { id: "female-05-06-12", width: 1536, height: 1024 };
const expressiveMale = { id: "male-01-06", width: 1536, height: 1024 };
const secretary = { id: "secretary-01-03", width: 1536, height: 512 };

// Display the selected artwork directly from the original sheets. The classic
// portrait catalog and its ID-based default assignment deliberately stay intact.
export const graphicAvatarData = {
  "female-03": { description: "红黑配色、长发挑眉", sheet: revisedFemale, crop: [55, 74, 596, 582], motion: [5.4, -4, -2] },
  "female-04": { description: "橄榄绿配色、长发大笑", sheet: revisedFemale, crop: [678, 74, 596, 582], motion: [4.6, 3, -4] },
  "female-05": { description: "金黄配色、长发仰望", sheet: expressiveFemale, crop: [1043, 21, 425, 412], motion: [5.8, -3, -2] },
  "female-06": { description: "粉色配色、长发眨眼", sheet: expressiveFemale, crop: [70, 500, 419, 414], motion: [5.1, -5, -3] },
  "female-07": { description: "蓝色配色、长发歪头", sheet: revisedFemale, crop: [1301, 74, 596, 582], motion: [6.1, 5, -3] },
  "female-12": { description: "红色配色、长发惊喜", sheet: expressiveFemale, crop: [1043, 501, 425, 414], motion: [4.4, -4, -4] },
  "male-01": { description: "红黑配色、短发挑眉", sheet: expressiveMale, crop: [68, 24, 424, 418], motion: [6.2, -3, -2] },
  "male-02": { description: "橄榄绿配色、短发大笑", sheet: expressiveMale, crop: [544, 24, 435, 417], motion: [5.7, 3, -2] },
  "male-03": { description: "金黄配色、短发仰望", sheet: expressiveMale, crop: [1043, 23, 424, 419], motion: [6.8, -2, -1.5] },
  "male-04": { description: "蓝色配色、短发眨眼", sheet: expressiveMale, crop: [68, 502, 425, 427], motion: [5.2, 4, -3] },
  "male-05": { description: "粉色配色、短发浅笑", sheet: expressiveMale, crop: [547, 502, 430, 426], motion: [5.5, -4, -2] },
  "male-06": { description: "红色配色、短发欢笑", sheet: expressiveMale, crop: [1040, 502, 428, 427], motion: [4.8, 4, -3] },
  "secretary-01": { description: "松青配色、黑发抱笔记本", sheet: secretary, crop: [81, 24, 340, 340], motion: [5.6, -3, -2] },
  "secretary-02": { description: "松青配色、马尾眨眼", sheet: secretary, crop: [583, 70, 340, 340], motion: [4.7, 4, -3] },
  "secretary-03": { description: "松青配色、银发蕾丝头饰", sheet: secretary, crop: [1100, 24, 340, 340], motion: [6.0, -4, -2] },
} as const satisfies Record<GraphicAvatarId, GraphicAvatar>;
