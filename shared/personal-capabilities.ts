/** Workspace image models are available to every active Agent. */
export const universalImageActions = ['image.models', 'image.generate'] as const;
/** Every assistant can display content, fetch web pages, discover tools and read bundled skills. */
export const universalActions = [...universalImageActions, 'html.render', 'web.fetch', 'tool.search', 'skill.list', 'skill.read'] as const;
