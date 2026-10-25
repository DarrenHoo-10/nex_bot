/** Workspace image models are available to every active Agent. */
export const universalImageActions = ['image.models', 'image.generate'] as const;
/** Publishing into the Agent's own sandboxed chat needs no device grant. */
export const universalActions = [...universalImageActions, 'html.render'] as const;
