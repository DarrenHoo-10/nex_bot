import fox from "./fox.svg?url";
import owl from "./owl.svg?url";
import cat from "./cat.svg?url";
import bear from "./bear.svg?url";
import rabbit from "./rabbit.svg?url";
import dog from "./dog.svg?url";
import panda from "./panda.svg?url";
import koala from "./koala.svg?url";
import tiger from "./tiger.svg?url";
import deer from "./deer.svg?url";
import penguin from "./penguin.svg?url";
import seal from "./seal.svg?url";
import otter from "./otter.svg?url";
import octopus from "./octopus.svg?url";
import frog from "./frog.svg?url";
import robot from "./robot.svg?url";
import astronaut from "./astronaut.svg?url";
import star from "./star.svg?url";
import cloud from "./cloud.svg?url";
import sprout from "./sprout.svg?url";

export const AVATARS = [
  { id: "fox", name: "赤狐", src: fox },
  { id: "owl", name: "知更", src: owl },
  { id: "cat", name: "芝麻", src: cat },
  { id: "bear", name: "麦芽", src: bear },
  { id: "rabbit", name: "棉朵", src: rabbit },
  { id: "dog", name: "吐司", src: dog },
  { id: "panda", name: "竹白", src: panda },
  { id: "koala", name: "尤加", src: koala },
  { id: "tiger", name: "橘山", src: tiger },
  { id: "deer", name: "林间", src: deer },
  { id: "penguin", name: "南极", src: penguin },
  { id: "seal", name: "海盐", src: seal },
  { id: "otter", name: "栗子", src: otter },
  { id: "octopus", name: "墨墨", src: octopus },
  { id: "frog", name: "青禾", src: frog },
  { id: "robot", name: "小钛", src: robot },
  { id: "astronaut", name: "阿波罗", src: astronaut },
  { id: "star", name: "星芒", src: star },
  { id: "cloud", name: "云团", src: cloud },
  { id: "sprout", name: "芽芽", src: sprout }
] as const;
export type AvatarId = typeof AVATARS[number]["id"];
