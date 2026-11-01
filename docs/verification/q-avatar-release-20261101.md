# Five assistant appearances — release verification

Scope: deepseek, claude, gpt, gemini and grok character choices, saved through
the existing versioned account appearance API. Existing saved graphic/classic
avatars retain their appearance. The right inspector uses an unframed character;
small contact/message avatars use a circular head-and-shoulder crop. Action
atlases are calibrated against idle height and a common floor.

Random idle actions are disabled. Task-state poses and idle blinking remain.
`needs_reconciliation` maps to confirmation rather than failure on Web and
Apple. Short image transitions do not constitute continuous skeletal animation.
The adult full-body prototype remains in the original local workspace and is
not included in the product or publication archives.

Planned packages: Windows 0.9.25, Android 0.2.24 (224), Mac/iOS 0.2.18 (20).
Release tag: `nexbot-v0.9.25-preview.1`.

## Implementation verification

- 27 targeted tests passed: isolated Core account/session appearance saving,
  invalid and stale writes, reload/restart persistence; playback, transitions,
  calibration and idle scheduler cancellation.
- Frontend TypeScript and changed-file lint passed.
- A fresh temporary Mac checkout compiled the native Mac application; four
  avatar rendering tests passed, including all five named characters in both
  small and large sizes and six task states. Shared native artwork is bundled,
  not downloaded from user-provided URLs.

## Publication evidence

Deployment, artifact digests and public update/download checks will be recorded
after builds from the pushed main commit complete. Until that record is added,
this file is not a claim that production or installer publication succeeded.
