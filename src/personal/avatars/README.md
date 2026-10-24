# NexBot Companions — 20 original vector portraits

The classic assets below remain for saved selections and legacy defaults. The
classic gallery has been removed from the picker. Twelve additional animated
graphic avatars, documented in [graphic/README.md](graphic/README.md), share the
**角色** picker with the original companions, without visible names or numbers.

Original artwork created for NexBot, 2026-10-17. No external artwork or fonts are
embedded. Each standalone SVG uses a 96 × 96 viewBox, a soft rounded background,
a distinct silhouette and a restrained palette. All artwork is resolution
independent and uses no external resources, scripts, filters or gradients.

`manifest.json` lists names and colors. `index.ts` imports the production assets.
`preferences.ts` stores each Agent's selection in the current client's local
storage under `nexbot.avatarPortraits.v1`. Existing legacy preferences are retained
but are not used by the new portrait collection. Defaults are stable by Agent ID.

Preview the legacy collection in `docs/design/avatar-collection.html` from the
repository root. The current selector under **更换头像** offers companions and
graphic characters; saved legacy portraits still appear in the sidebar, header,
inspector and picker preview until the user explicitly applies another choice.

The original 20 SVG load checks remain in the isolated renderer fixture.
Current behavior and evidence are recorded in
[`docs/verification/graphic-avatars.md`](../../../docs/verification/graphic-avatars.md).
