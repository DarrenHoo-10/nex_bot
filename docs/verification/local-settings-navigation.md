# Local-only settings navigation installation — 2026-10-17

The user requested this navigation update on their local machine first. The
production website remains on `07b02171`; it was not redeployed.

The local Windows installation now includes the approved UI assets in its
application archive. An optional shell helper serves only known static GET
resources from that archive, retaining the original Core origin, HTTP-only
cookie session, and preload authorization boundary. API requests, event streams,
and other resources pass through the same Electron session to the original
backend. Normal thin-client packages without the optional `ui/` directory do
not install any protocol override. No local proxy or local backend is started.

Verification:

- Two helper tests passed: static-resource allowlist/origin/method boundaries,
  request forwarding, and no interception for normal thin clients.
- The actual candidate executable passed 16 isolated shell checks, including
  proof that its document is local while API calls reach the independent Core,
  login persistence, logout, account switching, and workspace isolation.
- The UI had already passed 24 isolated workspace checks, including navigation
  shortcuts and real approved MCP calls.
- All 78 installed runtime files match the tested candidate. The encrypted
  login file was unchanged during replacement, and the installed app reopened.
- Public HTTPS resources still match the previous production manifest.

The shell remains version 0.9.1 with a local UI override. The previous install
is backed up alongside the installation. Evidence and the exact backup path
are in ignored `release/local-settings-navigation/local-installation.json`;
the candidate and archive inventory are in the same ignored directory.

To return to server-provided UI, restore the backed-up normal installation.
Do not delete the existing `NexBotClient` profile or saved credentials.
All mutating verification used disposable fixtures; the user's live account
was only opened normally after installation, not used for test interactions.
