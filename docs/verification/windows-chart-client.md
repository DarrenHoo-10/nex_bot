# Windows chart client fix — 2026-10-20

The public 0.9.4 portable EXE packaged `resources/client-ui`. Its static-protocol
override therefore served the bundled older UI even though Core had deployed
chart support. Restarting that EXE could not pick up the web update. The previous
release statement that restarting 0.9.4 was sufficient was incorrect.

Windows 0.9.6 removes that resource from the public packaging configuration.
The authenticated client loads Core's current UI; the existing executor,
native login, encrypted session storage and same-origin restrictions remain.
The optional local-UI development mechanism is unchanged.

## Isolated reproduction and acceptance

`scripts/smoke-client-charts.mjs` launches the actual portable EXE with its own
temporary profile, synthetic identity/model and disposable Core. Pass `--exe`,
`--ui-dir` and `--output`; use `--expect-old` only to reproduce the old package.
The UI snapshot used here matches all four public HTML/asset files byte-for-byte
from the deployed `chat-charts-20261020` release. No real account or conversation
was used or modified.

- The exact public 0.9.4 asset (SHA-256
  `ffe0c582bc180e06ff38b7c18f0f327b40174be641cbdd54a7411a7e5bd545d7`)
  reproduced four literal `chart` code blocks and the local-UI marker.
- The packaged 0.9.6 asset rendered the user's quarterly sales and monthly
  visitors examples, plus histogram and pie fixtures. Values, expanded data,
  histogram total, history reload and actual EXE restart passed. Ordinary JSON
  and HTML code blocks remained literal.
- Fetched client HTML equals the fixture server HTML; no local-UI marker or
  packaged `client-ui` directory exists. Version and executor inventory checks
  passed, and screenshots of old/new output were inspected.
- Both local-UI protocol unit tests passed. This fix changes the public package
  resource selection, not the chart JSON contract or the server renderer.
- The actual 0.9.6 EXE also passed all 24 account-workspace shell checks:
  login errors, encrypted restoration, automatic device connection and identity,
  pause/resume, logout/revocation, settings and cross-account isolation.

Evidence stays in ignored `release/windows-chart-fix/`. The published binary is
`NexBot-0.9.6-x64-Client-Portable.exe` (168976358 bytes), SHA-256
`f08f5e75ce3e687466c3213fe6a42273d1f638bd37d85148532ba9519e6b9e18`.
Use `SHA256SUMS-windows.txt`; existing Apple/Android assets are preserved.
The Windows build has no publisher Authenticode signature.

Users must exit the old EXE and launch 0.9.6. Do not clear their profile or
conversation data. Existing chart-fenced messages render on history reload.
