// Display names selected by the user. Stable asset IDs keep saved choices valid.
export const characterCatalog = {
  'blue-maid': {name:'deepseek',description:'蓝发女仆'},
  'orange-flower': {name:'claude',description:'橙发花饰'},
  'white-dragon': {name:'gpt',description:'白发龙角'},
  'purple-cat': {name:'gemini',description:'紫发猫耳'},
  'gold-bat': {name:'grok',description:'金发小恶魔'},
} as const;
export type CharacterId = keyof typeof characterCatalog;
export const characterIds = Object.keys(characterCatalog) as CharacterId[];
