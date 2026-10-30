# Todo design fixture

An isolated interactive UI prototype based on pushed main `6e2e3841`.
It imports the real NexBot workspace, atmosphere, glass styling, brand mark,
and secretary avatar components. No Core services or accounts are used.

Start from the repository root with dependencies installed:

```sh
node scripts/preview-todo-design.mjs
```

Open the printed loopback URL (default port 4318). `NEX_TODO_PORT` overrides
the port; `NEX_TODO_DEPENDENCIES` optionally points to a checkout with installed
dependencies. Re-run the launcher after changes, then reload the page.

Supports creation, editing, search, date/priority/owner changes, day/week/month
views, all/in-progress/not-started/completed filters, checklists, simulated execution, stop,
delivery, revisions, acceptance, reopening, deletion, theme switching, and
responsive navigation. Changes persist only in this browser origin under the
`nexbot.todo-design.v2` localStorage key. The sidebar's restore control resets
only these synthetic records. A single Todo entry replaces the previous sidebar
tabs; details use one continuous panel with a collapsible activity log.
Review items belong to the in-progress filter, while unscheduled tasks have a
separate tray. Date controls include previous/next period, today and a date picker.

Original React/CSS controls adapt the interaction ideas in Aceternity's
[Hover Border Gradient](https://ui.aceternity.com/components/hover-border-gradient)
and [Liquid Glass](https://ui.aceternity.com/components/liquid-glass) to NexBot's
existing palette. No Aceternity package or paid source was copied. Segmented
controls support arrow/Home/End keys; animations respect reduced motion.

AI execution and deliverables are explicitly simulated. This is not a Core
integration, native Apple client implementation, or production release.
GitHub, OSS, client packaging and production deployment are out of scope.

## Verification (2026-10-30)

The isolated page was built and exercised in the in-app browser at desktop and
390 × 844 mobile widths. Verified new-item forms, quick creation, editing,
assignment, simulated execution and delivery, revision feedback, stopping,
acceptance, result-title correspondence, persistence after reload, search,
list/board switching, light/dark themes, mobile detail navigation, and restoring
the seed records. Browser error/warning logs were empty during the checks.
Those checks describe the initial design. The revised calendar design was also
checked at desktop and 390 × 844: all three time views, the four status filters,
month navigation, mobile calendar-to-day navigation, details without tabs and
the expandable activity log. Browser error/warning logs remained empty.
Four date-model tests cover month-end clamping, leap years, year boundaries,
Monday-based weeks, six-row months and review-status filtering. Run them with
`node --test scripts/testing/todo-design/calendar-model.test.mjs`.
The mobile document width was 390px at a 390px viewport. Fixed an outer-shell
scroll issue found while selecting off-screen tasks; only the list/detail
regions now scroll. `git diff --check` passed.

## Attribute picker revision (2026-10-30)

Replaced native owner/priority selects and date inputs in creation, editing,
details and calendar navigation with shared custom pickers. Top-layer popovers
remain within the dialog DOM and flip/clamp at viewport edges. Owner choices
include real avatars; priority choices use muted dots; the date picker includes
month navigation, today/tomorrow/next-week shortcuts and clearing. Hidden form
fields preserve submission values. Esc closes only the active picker.

Browser verification covered arrow-key selection, calendar arrow keys, saving
owner/date/priority to a temporary fixture item, clearing its date, and removing
that temporary item afterwards. Existing records were retained. Checked light
and dark themes, dialog Esc behavior, and 390px-wide mobile calendar visibility
with no horizontal overflow. Browser error/warning logs were empty. AI remains
simulated and no production or native client surface was changed.

## Text field polish (2026-10-30)

Title, description, revision text, search and quick capture now share inset
surfaces, restrained borders, teal caret and focus treatment. Description areas
size with content within a bounded scroll region. Mobile text uses 16px fonts.
Verified light/dark focus appearance, multiline entry, search interaction and
390px mobile layout with no horizontal overflow. Browser warning/error logs
were empty; the preview build succeeded. This revision changes only fixture CSS.
