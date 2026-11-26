/** Workspace image models are available to every active Agent. */
export const universalImageActions = ['image.models', 'image.generate'] as const;
/** Every assistant can display content, discover tools and read bundled skills. */
export const universalActions = [...universalImageActions, 'html.render', 'tool.search', 'skill.list', 'skill.read'] as const;
