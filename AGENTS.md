# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

## Production deploys and releases

Deploy production (Core, web UI) and build published client packages only from
a commit on `main` that has been pushed to `origin`. Never deploy or publish from
any other branch, a worktree branch, or uncommitted files. Merge the change into
`main` first. This rule is not overridden by subdirectory `AGENTS.md` files.

项目必须用主分支（`main`）部署线上，严禁用非主分支或未提交的代码部署线上或打包发布。

## Product UI copy

Keep product screens concise. Do not add explanatory paragraphs, implementation
notes, permission tutorials or redundant subtitles unless the user requests them.
Use labels, actual status, necessary errors and direct controls. Device login
starts local control automatically; retain Pause/Resume and stop on logout.
