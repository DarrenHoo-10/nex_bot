# Apple chart preview verification

The Apple preview workflow compiles native macOS, iOS Simulator and iOS device
targets from one source commit. Run `bash apps/apple/scripts/release-preview.sh`
on a Mac after installing dependencies, XcodeGen, and staging the executor with
`node scripts/build-mac-executor.mjs`.

Before packaging, the workflow runs NexClientKit and NexMarkdown package tests,
then hosted XCTest fixtures on macOS and an available iPhone simulator. The
fixtures compile the production `Shared/StaticHTMLMessage.swift` and its bundled
chart renderer into separate, account-free apps. They never connect to Core or
read user profiles. Assertions cover four rendered SVG chart types, point click
values, histogram/pie data, expansion height, narrow/wide layout, dark mode and
disabled page scripts. Screenshots are retained as XCTest attachments.

The DMG is Apple Silicon and ad-hoc signed, without Apple notarization. The IPA
is an unsigned device build and requires the recipient's own Apple signing and
provisioning before installation. An iOS Simulator build is also required by the
workflow; simulator tests do not establish installation on a physical device.

Only upload installers after a successful run and review of the `.xcresult`
reports. Record the source commit, run URL, test results and installer hashes in
the release notes. Source preparation and a generated workflow alone are not
evidence of a successful Apple build or a published release.

## 2026-10-20 release acceptance

Published Mac and iOS 0.2.1 (build 3) to the existing
[0.9.6 preview release](https://github.com/DarrenHoo-10/nex_bot/releases/tag/nexbot-v0.9.6-preview.1),
preserving its Android assets and original tag.

Installer source: `42d13813628352aac2a4f10c9552469b934f4493`.
The [full build run](https://github.com/DarrenHoo-10/nex_bot/actions/runs/39300105046)
passed Mac Release, iOS Simulator Debug and iOS device Release compilation,
103 NexClientKit tests, 21 NexMarkdown tests and 8 shared chart tests. Mac
deep signature verification and packaged executor checks also passed.

Both native WebKit fixtures passed four chart types, numeric interactions,
data-table expansion height, dark mode and narrow/wide layout assertions.
An earlier iOS height check exposed delayed expansion sizing; the production
renderer now measures on the details toggle event, with bounded fixture waits.

The first successful run's iOS screenshots were transparent because the test
window was not attached to a UIWindowScene. The test-only follow-up at
`8708a055` attaches the visible window and checks for actual chart pixels.
The [visible fixture run](https://github.com/DarrenHoo-10/nex_bot/actions/runs/39303911756)
passed on macOS 26.6.2 and iPhone 17 Pro Simulator / iOS 26.4.1. Exported
screenshots were inspected; visible chart bars, labels, selected values and
dark-mode output were present. CI verified production sources were unchanged
from the installer commit before reusing those installer bytes.

Published asset sizes and GitHub SHA-256 digests match locally verified files:

| Installer | Bytes | SHA-256 |
| --- | ---: | --- |
| NexBot-0.2.1-mac-arm64.dmg | 70359264 | `b2bee97c15f9c73000c504c469ba00c143b0cb6b85ab303c3462794f6d8781bd` |
| NexBot-0.2.1-ios-unsigned.ipa | 5159133 | `79c5afdd1200a668e363eb32d240ae0b7cfc420be13e79cd859d71828d24c94f` |

The IPA was checked for version/build, arm64 executable, bundled chart resource
and absence of credentials/signing material. Separate checksum files accompany
both installers. Mac requires Apple Silicon and macOS 14+; it is ad-hoc signed
and not notarized. iOS requires 17+, recipient signing and provisioning. No
physical iPhone installation or App Store/TestFlight distribution was verified.
All native rendering checks used isolated, account-free fixture applications.
The release's automatic source archives retain the original tag; use the
installer source commit above to reproduce these Apple packages.
