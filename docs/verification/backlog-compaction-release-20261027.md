# Backlog compaction: Core release (2026-10-27)

Commit `253829a6` (pushed `main`) makes history far larger than the model
window compact instead of failing with “待整理内容超出模型窗口”. Behaviour and
test evidence: [Tool context follows total capacity](tool-context-budget.md).

## Deployment

- Built with `node scripts/build-personal.mjs --core` from the pushed commit;
  overlay `core`, `ui`, `package.json`, `SOURCE_COMMIT`, SHA-256
  `5954e9644a4655284c58aadba660b2bf83b0e65e33f43f0bb6701ac00e5f089c`.
- Staged `/data/nexbot/releases/main-253829a6-20261027`, copied from
  `main-56c4c19b-20261025`.
- Throwaway Core on Tokyo (synthetic model, real worker): five 60,000-character
  attachment results read under a 3M window, then a turn at 200k / 32k output.
  The **previous release reproduced** “待整理内容超出模型窗口”; the new release
  succeeded with 6 summarizer calls (largest 91,361 estimated tokens) and a
  final request of 4,791. Schema 25, UI assets, preview sandbox and 401s also checked.
- Deployed with no active tasks: backup
  `/data/nexbot/backups/main-253829a6-20261027-pre`, drop-in
  `zzzzzzzzzzzzzzzzzzzzzzzzzz-backlog-release.conf`. Post-switch checks passed:
  health 200, six workspace databases with unchanged identity, model, secret and
  policy hashes, vault keys and schema, unauthenticated API 401.
- Public `https://bot.nexorai.com.cn`: HTML and all six assets byte-identical to
  the local build, `/health` 200, `/api/state` 401, preview CSP sandboxed. Deployed
  `core/worker.js` and `core/index.js` match the local build's SHA-256.

## Not done

- No client was rebuilt or published: the change is Core-only and every client
  uses Core's worker. README, homepage and the update manifest are unchanged.
- The affected production conversation (`b9568ec9`) was not retried; it compacts
  on its next turn. Real-model summary quality is not verified by the fixtures.
- The overlay, like the previous clean builds, has no `core/export-fonts`;
  nothing on `main` references it.
