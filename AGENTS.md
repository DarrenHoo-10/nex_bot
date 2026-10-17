# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Product UI copy

Keep product screens concise. Do not add explanatory paragraphs, implementation
notes, permission tutorials or redundant subtitles unless the user requests them.
Use labels, actual status, necessary errors and direct controls. Device login
starts local control automatically; retain Pause/Resume and stop on logout.
