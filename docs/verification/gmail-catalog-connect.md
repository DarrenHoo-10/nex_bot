# Gmail Connect from the connector catalog — 2026-10-24

The connector list shows **连接** on the Gmail row while no mailbox is linked, so
authorization starts without opening the detail page. Linked rows still show
**已添加** and open the details; an unavailable service shows its previous state.
Opening the details while an attempt is pending abandons it, as leaving the
details already did.

## Platforms

| Platform | Change | State |
| --- | --- | --- |
| Web / Windows | `src/personal/ConnectorsPage.tsx`, `connectors.css` | Core deployed from `7f7a5036`; Windows loads the UI from Core |
| Android | Same web bundle inside the APK | Debug APK 0.2.11 built from `7f7a5036`; **not published**. Its version equals the published 0.2.11 asset, so it cannot be offered as an update |
| macOS / iOS | `GmailCatalogButton` in `apps/apple/Shared/GmailConnectorView.swift`, shared by both | Built and rendered on a Mac; not merged or published at the time of writing |

## Verification

All checks used synthetic data and owned fixtures.

- Web renderer (`scripts/smoke-gmail-connectors.mjs`): the nine existing groups
  and two new ones passed. The new groups cover the direct button, blocked popup,
  cancellation, a 390 px layout, abandoning by opening the details, and a full
  catalog connection that grants no tools.
- Android: 78 native unit tests passed; the APK verifies under signature scheme
  v2 and bundles the new UI.
- Apple, on a Mac (macOS 15.6, Xcode 16.4): `NexClientKit` 128 tests passed;
  `scripts/smoke-apple-gmail.mjs` rendered the detail page and the catalog row
  (connect, authorizing, added, unavailable; light, dark, 390 pt); the macOS
  Debug build and the iOS Simulator Debug build succeeded with no errors and no
  warnings in the changed file.
- Production: public JS and CSS matched the local build byte for byte and carry the
  new class names; privacy page, health and 401 checks passed.

## Not verified

- No native tap-through: the Apple states are static renders of fixtures, and the
  authorization logic is covered by the existing `ConnectorAuthorization` tests.
- No physical Android phone, iPhone or real Google account. Release and device
  builds for Apple were not run.
- The Mac build used a stand-in icon file because `build/nexbot-icon.icns` is generated.
