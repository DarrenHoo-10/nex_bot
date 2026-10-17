# Unified login and logout — 2026-10-17

The desktop used two login surfaces: the React LoginGate and the independent
Electron connection page. Logout cleared React authentication state before
waiting for `forgetLogin` to clear Chromium storage and navigate to the shell
login, visibly switching between different designs. Authentication refresh
could also leave the desktop displaying the web login.

Changes:

- Web and shell login share `electron/client/style.css`, a blue companion mark,
  email/password form, and a compact registration footer. Removed the English
  eyebrow, descriptive paragraph, and visible desktop-name field; the desktop
  still supplies its device name automatically.
- Both account-menu and settings logout use the same accessible HTML dialog,
  with cancel autofocus, Escape cancellation, focus containment, busy state,
  errors, and light/dark colors. No system JavaScript confirm is used.
- Desktop logout leaves the authenticated React view until the shell navigates.
  Authentication refresh is fenced during logout; confirmed unauthentication
  returns directly to the canonical shell page. Credential removal clears
  resume state and stale errors and advances the login epoch.
- The initial login-only change found `/register` unavailable. The subsequent
  [invitation registration update](invite-registration.md) supersedes that
  temporary state: both login surfaces now link to `/register/nexbot`.

Validation passed in isolated fixtures only:

- Frontend TypeScript, changed-file lint, and UI/Core build.
- 26 renderer cases, including settings logout cancellation, account-menu
  confirmation, simplified login and registration-availability feedback.
- 25 actual packaged-shell checks, including cancel/confirm, no intermediate
  web login form (DOM observer through CDP), stable shell login after waiting
  31 seconds, active-session invalidation, restart/login restoration and
  account isolation. Tests used synthetic identity/model services.
- Visually inspected the web login, packaged login and logout dialog. Their
  synthetic reference screenshots are saved in `doc/ui`.

The local package is in ignored `release/local-login-refresh/`; its install
script backs up the prior installation, verifies all runtime files, preserves
the encrypted saved login, then reopens the app. Production services and Git
remotes are unchanged by this task.
