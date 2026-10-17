# NexBot Companions — 20 original vector portraits

Original artwork created for NexBot, 2026-10-17. No external artwork or fonts are
embedded. Each standalone SVG uses a 96 × 96 viewBox, a soft rounded background,
a distinct silhouette and a restrained palette. All artwork is resolution
independent and uses no external resources, scripts, filters or gradients.

`manifest.json` lists names and colors. `index.ts` imports the production assets.
`preferences.ts` stores each Agent's selection in the current client's local
storage under `nexbot.avatarPortraits.v1`. Existing legacy preferences are retained
but are not used by the new portrait collection. Defaults are stable by Agent ID.

Preview the entire collection in `docs/design/avatar-collection.html` from the
repository root. The actual UI selector is available under **更换头像** in the
Agent inspector. It displays all 20 portraits, supports keyboard navigation and
updates the sidebar, header and inspector immediately.

Verified through the isolated real renderer: all 20 SVGs load, selecting a
portrait updates all three locations, and the choice survives a full reload.
The full Personal workspace fixture (13 checks), frontend TypeScript, lint and
Core build passed. Screenshots are in
`release/workspace-verification-avatars/`, including `avatar-collection.png` and
`avatar-picker.png`.
