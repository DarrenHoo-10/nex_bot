# Image attachments and the context estimate — release 2026-10-24

Sending a photo ("能看到图片吗") failed with "压缩后仍超过上下文预算（估算 552070 /
400000 Token）". The model reads attachments with `attachment.read`, which returns the
image as base64 inside the tool result. The offline estimate (`tokens()` in
`server/personal-os/token-estimate.ts`) stringified the whole message, so a 1.2 MB
photo (~1.65M base64 characters) counted as ~550k tokens. That tool result belongs to
the current turn, which compaction cannot shrink, so the turn failed even in a new
conversation. Providers bill such an image at roughly 1100–1600 tokens.

Image parts (`image`, `image_url`, `input_image`) now cost a flat 2000 tokens in
every estimate. The request-boundary check in `worker.ts` estimates the payload
object rather than its serialized string, and the text sent to the compaction
summarizer replaces image parts with `[图片]` (the original entry keeps the image).
Screenshots from computer use benefit too: they were previously counted at tens of
thousands of tokens each and collapsed early.

The fix is `a35001d2` (`a35001d269a3fd5880622c8b8e96300e74502ee6`), pushed to
`origin/main` before it was built and deployed. Only Core changed; no client package
contains this code, so no client was rebuilt or published.

| Platform | Version | Delivery |
| --- | --- | --- |
| Web / Core | `a35001d2` | Deployed to Tokyo as `main-a35001d2-20261024` |
| Windows / Android / macOS / iOS | unchanged | Not affected; they use the deployed Core |

## Verification

All checks used synthetic data and owned fixtures.

- Tests: `token-estimate.test.ts` covers the three image shapes. A new
  `chat-composer.test.ts` case uploads a 900 KB image through a real worker with a
  64k window and a fake model; it fails on the previous code (task `failed`) and
  passes with the fix, and the final model request contains the whole image.
  Lint and typecheck pass.
- Release candidate: on Tokyo, a throwaway Core started from the staged release ran
  the same flow against a synthetic model (1,200,012 base64 characters, 64k window):
  the task succeeded and the image reached the model intact.
- Production: the deploy ran with no active tasks, data and config were backed up
  first, and data hashes in all five workspaces were unchanged. The public HTML and
  every referenced asset match a fresh build of the release commit byte for byte;
  health 200, unauthenticated API 401.

## Not verified

- No real provider request with a real photo after the deploy; the flat 2000 tokens
  is an estimate, and provider receipts remain the usage authority.
- The full `server/personal-os` suite has failures unrelated to this change:
  `continuity.test.ts` "migrates mixed old switches…" fails identically on the
  previous commit (`duplicate column name: provider`), and a few tests failed once
  under full parallel load and passed on rerun.

## Rollback

The previous Tokyo release (`main-64d91101-20261024`) and the pre-deploy backup
(`/data/nexbot/backups/main-a35001d2-20261024-pre`) are kept.
