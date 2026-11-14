# Agent mode: sending while someone is typing (2026-11-15)

Question: when a person has an unsent draft in a terminal on the computer, can
the web client send a message without mixing it into the draft?

Finding from the [phase 0 spike](agent-mode-spike-20261115.md) (item 3b):
`terminal.send` waits up to 60 s for the local viewer, then submits the draft
and the message as one line.

Check of the guard, `HerdrCore.sendGuarded` in
`server/personal-os/cli-agents-node/hc.ts`, which sends on a throwaway
connection and gives up after a short time:

- Real herdr-core 0.1.21 in an isolated session (`HC_SESSION=nexbot-<random>`,
  its own pipe), the fake program `scripts/testing/fake-tui.mjs`, one attached
  viewer that typed `draft-text` without Enter.
- `sendGuarded({ text: "SENT" }, { giveUpMs: 3000 })` failed with kind
  `hc_draft`. Three seconds later the screen still held the draft; after the
  viewer pressed Enter the program echoed `you said: draft-text` and the screen
  never contained `SENT`. Closing the throwaway connection therefore cancelled
  the pending send and left the draft alone.
- The core, its terminal holder and state directory were removed afterwards;
  the user's classic herdr was not touched.

Limits: one run on Windows; a slow core looks like a draft (the bridge then
answers `busy`), and a send that lands just as the guard gives up is possible.
The bridge unit tests cover the refusal path with a fake herdr-core, and
`NEX_HC_REAL=1 vitest run server/personal-os/cli-agents-node/integration.test.ts`
covers start, terminal relay and detach against the real binary.
