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
