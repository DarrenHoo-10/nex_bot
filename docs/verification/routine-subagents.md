# Routine subagents and scheduling — 2026-10-30

This record covers the current Personal Core (`server/personal-os`), not the legacy `server/routines.ts` scheduler.

## Behaviour

- A routine creates an independent child conversation, task and worker under its owning assistant. It does not occupy or steer the owner's conversation. Owner messages do not cancel it.
- Each assistant has its own four-worker capacity, with at most three background workers so owner chat retains a slot. The scheduler admits one routine child per assistant at a time. Different assistants do not share a global queue-head/worker cap; physical devices and external services still have their own resource constraints.
- Completed work publishes one named result to the assistant's inbox. The owner's model receives bounded references to recent reports at subsequent request boundaries. Intermediate output stays in the child transcript; reports do not inject user input. Recovery backfills missing reports without replaying completed tasks or duplicating old reports.
- Minimum repeating interval is five minutes. One-shot reminders can be sooner. Migration 36 raises existing shorter intervals to five minutes and collapses old pending scheduled backlog.
- Reminder grace is five minutes; monitor grace is one interval, capped at fifteen minutes (fifteen for non-interval monitors); report grace is twelve hours; action grace is thirty minutes. The model chooses `taskKind` by task intent; task configuration is assistant-managed. Old plans default by schedule kind: once/reminder, interval/monitor, daily/report.
- Late pending work becomes `skipped` with a reason. Periodic backlog retains only the latest pending scheduled occurrence. A first-start check also enforces expiry after authorization/capacity waits; the scheduler expires never-started tasks even when authorization continuously returns false, releasing the assistant's routine slot. Already-started work is not expired during recovery. Manual runs do not use the scheduled lateness deadline.
- Editing content preserves enabled state and cadence. Changing timing cancels only pending scheduled work; each occurrence retains its original name, prompt and category. Pause cancels pending scheduled work, not an active child or an explicit manual run.
- Web/Windows/Android shared UI and native Mac/iOS expose a run-detail entry from recent execution. Details include status, transcript, timestamps and tool previews. Web polls while open and active; Apple has explicit refresh. Main-chat activity and streaming exclude routine children.
- The final product surface is read-only task management: view the plan/results, close future scheduling, or delete the plan with confirmation. Creation, editing, immediate execution and re-enabling belong to the assistant; client editor and manual-run entry points were removed. Close retains the plan; delete hides it using migration 37's `deleted_at`, cancels pending occurrences and rejects later mutations. Already-dispatched work and historical results remain intact.

## Verification

All mutations use owned disposable data directories, synthetic identity/model providers and isolated clients. No live service, account, task or data was changed.

- Scheduler regression suite: 12 passed, covering migration, phase/paused-state preservation, occurrence snapshots, five-minute validation, backlog collapse, cross-assistant dispatch, lateness categories, manual idempotency, details and dispatch-error isolation. The final migration/backlog test was rerun after the migration changed; an earlier concurrently running combined command had loaded its old schema and reported that case failed.
- Full Core app suite: 44 passed, one existing skip (missing legacy database fixture). Full maintenance suite: 15 passed. An existing capability assertion omitted the already-universal `html.render`; the expectation was corrected and passed both its focused rerun and the full app suite.
- Core fake-engine integration covers scheduled creation, restart receipts, concurrent owner/routine execution, approval isolation and final-report delivery. Dedicated child fixtures: 7 passed, covering model-visible reports without steering, per-assistant capacity, missing-report recovery, first-start expiry and permanently denied authorization releasing the next routine. Generated-image tests verify access during execution, final report binding, cross-assistant denial, forgotten-task denial and retention during orphan cleanup. HTML/image regression: 12 passed; the routine/image/attachment-object combination after the attachment fix passed 18 tests (before the seventh routine case was added). These final dedicated runs were foreground commands; their raw results remain in the executing agent's tool transcript rather than standalone log files.
- Web component suites: 25 tests passed. Frontend and backend TypeScript checks passed.
- Real Chromium fixture: five groups passed, with no Runtime exceptions: once timestamp precision, changed date/category persistence, interval validation, actual worker execution/detail/tool preview, and 390px layout without horizontal overflow.
- Reproduce the browser fixture with `node scripts/testing/smoke-personal-routines.mjs`. It builds temporary UI/Core/worker files, uses a fake identity/model and an isolated Electron profile, and cleans its test data.
- Apple source was copied with LF endings to fresh temporary directories on `mac-air`. NexClientKit: 174 tests passed; Mac and iOS Debug builds passed; native run-detail rendering fixtures passed on Mac and a dedicated iOS simulator. Both temporary directory and simulator were removed. Final status-precedence and past-once-date editing corrections passed all 24 ActionsTests in another fresh directory; final Mac and iOS Debug builds also passed after retrying transient dependency-download TLS failures. That directory was removed.
- Changed-source lint and whitespace checks passed.

## Earlier design iterations (superseded)

The following editor/dropdown verification records describe intermediate designs. User feedback subsequently made task management assistant-owned; those editors and the new standalone dropdown component were removed. The final UI and its verification are recorded below.

### Everyday-language redesign

Following feedback that the interface exposed too much implementation detail, the task list now emphasizes the name, natural schedule, next time and recent result. Editors ask what to do and when; category and timezone remain available under collapsed “更多设置”. Completed one-shot plans show “已结束”. Results appear first, while “查看过程” and “任务安排” are collapsed by default; intermediate messages and tool previews remain accessible.

The redesign passed 26 Web component tests and the frontend TypeScript check. The isolated Chromium fixture passed all five groups again, including result-first display, expanding the process to inspect tools and the 390px layout. Mac/iOS Debug builds passed; native rendering tests passed 4/4 on each platform (success, failure, awaiting confirmation and task list). Dedicated simulator and temporary sources were removed. Apple editors were compiled but not separately screenshot-tested. Backend behavior was unchanged during this visual iteration, so the earlier Core suites were not repeated. Vite reported the existing large-bundle advisory; no browser runtime exceptions occurred.

## Glass controls

Button and input styling references were read from Aceternity's [Tailwind CSS buttons](https://ui.aceternity.com/components/tailwindcss-buttons) (Backdrop blur / Outline) and [Signup Form](https://ui.aceternity.com/components/signup-form). The implementation uses existing React/CSS and workspace tokens: soft outlines, inner highlights, modest shadows and teal primary actions. No animation library was added.

The routine editor uses a top-layer combobox/listbox with selected checks, arrow/Home/End navigation, Enter/Space selection, Escape dismissal, outside dismissal and normal Tab navigation. Time/date inputs remain native. The component run passed 26 tests; an additional menu-dismissal regression then passed in the 14-test routine suite (27 component cases total with the unchanged 13 composer cases). Escape and outside clicks preserve the selected value and do not submit. happy-dom stubs only its missing popover methods, with real popovers exercised in Chromium. The final browser fixture passed seven groups with no runtime exceptions, including keyboard selection, mobile popover bounds, the dark theme and the computed primary-button gradient. Screenshots wait for finite animations to finish. Native Mac/iOS retain native menus and date pickers, with shared scoped button/field styles, 44pt button targets, disabled states and reduced-motion support. Full app builds and six rendering fixtures per platform passed. After the final 120pt text-editor height refinement, both platforms compiled the updated shared component and passed two targeted light/dark editor rendering tests each; full app builds were not repeated for that height-only change. Native screenshots use the real shared editor fields in an isolated rendering harness; their bottom button sample is for style verification, while the actual iOS sheet keeps Save/Cancel in its toolbar. Pressed-state animation and screen-reader output were not automated.

## Final assistant-managed interface

The task name opens a read-only plan even before its first run. Only viewing results, closing future scheduling and deleting the plan are available; there are no creation/edit/run/re-enable controls or input fields. Close/delete require confirmation and surface version conflicts without losing the dialog. The glass-style action buttons remain.

Web component suites passed 24 tests; frontend type checking passed. The isolated real Chromium run passed four groups: read-only plan with no manual creation/edit/run controls, result/tool detail, 390px layout, and confirmed close/delete with dark-mode rendering. It checked that cancelling confirmation preserves enabled state, closing sets enabled=0, and deleting removes the plan from the returned state.

Backend deletion verification: the full `routines-isolation`, `routine-isolation` and `continuity` suites passed 61 tests; six existing app routine tests also passed. Backend TypeScript and whitespace checks passed. Disposable Core fixtures cover migration 37 without rewriting migration 36, authentication, version conflicts, deletion persistence, prevention of resurrection through mutations or old tool receipts, cancellation of both pending trigger types, active work completing normally and preserved historical details. The old continuity migration fixture now clears only migration markers 16–35, matching the schema it actually rolls back.

Native verification: 27 ActionsTests passed, including delete payload/version and refresh behavior; Mac/iOS full Debug builds passed and each platform passed six rendering cases. The native API tests use synthetic URLProtocol responses, not an integrated call to the new Core endpoint; native confirmations were compiled but not automatically clicked. Temporary Mac sources and the dedicated simulator were removed.

Final screenshots:

- [Web read-only plan](images/routine-subagents/routine-readonly-desktop.png)
- [Web dark read-only plan](images/routine-subagents/routine-readonly-dark.png)
- [iOS read-only plan](images/routine-subagents/ios-readonly.png)
- [Mac read-only plan](images/routine-subagents/mac-readonly.png)

Historical iteration screenshots (editor/dropdown images no longer represent the product):

- [Web task list](images/routine-subagents/web-list.png)
- [Web editor](images/routine-subagents/web-editor.png)
- [Web dropdown](images/routine-subagents/web-dropdown.png)
- [Mobile dropdown](images/routine-subagents/web-dropdown-mobile.png)
- [Dark dropdown](images/routine-subagents/web-dropdown-dark.png)
- [iOS task list](images/routine-subagents/ios-list.png)
- [iOS editor controls](images/routine-subagents/ios-editor.png)
- [Mac editor controls](images/routine-subagents/mac-editor.png)
- [Web detail](images/routine-subagents/web-detail.png)
- [Web mobile viewport](images/routine-subagents/web-mobile-detail.png)
- [Mac detail](images/routine-subagents/mac-detail.png)
- [iOS detail](images/routine-subagents/ios-detail.png)

## Limits

No production deployment or installer publication was requested. Windows/Android changes are in their shared web UI; no NSIS/APK was built. Native Apple fixtures use synthetic API responses and do not prove a physical-device connection to production Core. The Apple fixture did not automate the entire editor interaction chain or tool-expansion button; shared-client tests verify requests and concurrency. Chromium was exercised, not other browser engines. Worker budgets are per assistant, so aggregate concurrency grows with assistant count; production load capacity was not tested. Existing historical receipts cannot recover a definition that was edited before snapshots existed; their migration uses the available saved definition.
