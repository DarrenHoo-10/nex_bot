# Invitation registration — 2026-10-17

The invitation registration implementation belongs to the adjacent `nex_user`
identity service, preserving the existing NexorAI identity and Core workspace
routing. NexBot's web and desktop registration links now open
`https://user.nexorai.com.cn/register/nexbot` in a browser.

The identity service adds dedicated, rate-limited registration and email-code
routes, an operator-owned JSON allowlist read on every request, and a database
ledger containing only invitation hashes. Successful account creation and
single-use consumption commit together. Missing/invalid/disabled config fails
closed; deleting and re-adding a consumed code never makes it reusable.

Validation:

- Identity service tests and vet passed.
- A separately created MySQL database and user were used for integration:
  synthetic email-code delivery, two concurrent attempts with one invite,
  exactly one successful account, login with the new account, persistent use
  tracking across service recreation, loser retry with an added code, and hot
  removal. The isolated database/user were removed afterwards.
- Production rollout used deployed base `cdae808` plus only the invitation
  changes. A new usage table was added; existing account tables were unchanged.
  The application's DB account intentionally cannot create tables, so migration
  used the administrative database channel instead of granting it more rights.
- Public registration, existing login and health URLs returned 200; the new
  page has a script-hash CSP. Production verification used GET requests only;
  no real account or invitation was consumed, and no test email was sent.
- The updated client is tested with the existing isolated renderer/package
  suites. A separate empty Electron profile captures the public registration
  page without entering data or submitting it.

Private production configuration lives at
`/etc/nexorai-user-service/nexbot-invites.json` (0600, service owner). Ten
independent 160-bit codes were generated outside Git. Editing `enabled` or
the `codes` array takes effect on subsequent requests without restart. The
configured filename remains fixed in the service environment.

Release/rollback evidence is under ignored `release/invite-registration/`.
Local desktop packaging is under ignored `release/local-invite-registration/`.
Real invitation contents and operational credentials are excluded from both
repositories, release archives and UI screenshots.
