/** Workspace image models are available to every active Agent. */
export const universalImageActions = ['image.models', 'image.generate'] as const;
/** Sandboxed display and reading the authorized tool catalog need no device grant. */
export const universalActions = [...universalImageActions, 'html.render', 'tool.search'] as const;
