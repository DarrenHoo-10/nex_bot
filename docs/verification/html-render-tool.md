# Discoverable HTML rendering — 2026-10-25

The existing renderer accepted top-level `html-preview` fences, but the model's
chart prompt prohibited HTML/SVG and described only four built-in chart types.
A request for a vertical funnel could therefore produce a bar chart or a false
claim that the client could not display it.

`broker` now advertises `html.render(content)` with its input format, intended
uses and sandbox limits. The chart prompt routes custom layouts to this action
and removes the conflicting prohibition. Built-in chart JSON remains available.

The action publishes a preview message into the executing Agent's own feed,
in the same transaction as the successful tool result. It returns a message ID
and `published` status, not the HTML again or a claim that browser execution
succeeded. Its source key is tied to the tool call; interrupted execution is
recoverable. Content must be nonempty and at most 500,000 JavaScript string
characters. Variable-length fences keep backticks in generated HTML from
breaking out into ordinary chat Markdown.

This is a basic display capability for every active Agent, including existing
explicit tool lists. It grants no device or connector access. Web, Mac and iOS
permission editors show the capability as always enabled. The existing sandbox
continues to isolate the document from the parent, native bridges and network.
There is no new funnel-specific component or browser privilege.

## Verification

- 25 tests passed across `html-render`, `image-models`, `html-preview` and
  `chat-charts`. A disposable Core and scripted model exercised discovery,
  the Broker, publication and reply completion. The fixture verifies a single
  preview in the current Agent even if another Agent ID is supplied, no
  approval, a compact receipt, and no conflicting prompt prohibition.
- Source validation, inactive/unknown Agent rejection, retained device-access
  restrictions and nested-fence round trips are covered.
- The existing Electron HTML preview fixture passed 16 checks with local
  assets, including the tool's message format displaying five vertical funnel
  stages at 390px width, no horizontal overflow, blocked external requests,
  sandbox isolation, stop/restart and history reload. It made zero requests for
  a remote preview shell. Screenshot: ignored
  `release/html-preview/local-ui/funnel.png`; report in the same directory.
- Frontend/server TypeScript, changed-file lint, diff whitespace check and
  Core build passed. The fixture bundler was updated to load the PNG assets
  now imported by the shared UI.
- On `mac-air`, 129 NexClientKit tests and both macOS/iOS Simulator Debug builds
  passed in a fresh temporary source directory. Logs were copied to ignored
  `release/send-latency/html-tool-*.log`; the directory was then removed.

## Delivery limits

The local Windows test client's UI assets were refreshed, but its account still
connects to the existing hosted Core. This feature requires deploying the new
Core; a client restart alone does not change the model's tools or prompt.
No hosted Core, GitHub release or OSS manifest was changed. Verification used
synthetic data and a scripted model; it does not prove every model will select
the correct tool or produce valid HTML on every request.
