# Graphic avatar additions

The user selected the six retained feminine designs (03, 04, 05, 06, 07, 12)
and the first masculine sheet (M01–M06) on 2026-10-24. The PNGs are exact copies
of the selected Image Generation outputs, not redraws. They are bundled local
assets; no external image service is required at runtime.

`../graphic.ts` defines the selected viewports and stable graphic appearance IDs.
`GraphicPortrait` displays only each selected region through an SVG viewport and
round clipping. Labels and rejected cells on the original sheets are not shown.

This collection is additive. Do not expand or reorder the classic `AVATARS`
array, change its ID-based defaults, or migrate existing companion/portrait
selections. Graphic choices use the existing explicit-save/version-check flow.
The picker displays all twelve in the same **角色** section, without gender
headings, numbers or names. Accessible labels describe the artwork; stable IDs
are storage keys only. The classic gallery is removed from selection, but saved
classic portraits still render and are never automatically replaced.

State motion transforms the original artwork without redrawing it: gentle idle
breathing, a thoughtful tilt, a working nod and one completion acknowledgment.
Each character has its own tempo, tilt and lift. This is whole-character motion,
not a new frame sequence or independently animated facial features. Approval,
paused, failed and offline poses remain still. Picker thumbnails and idle sidebar
contacts stay quiet; previews, header and inspector animate when enabled.
The existing badge remains visible. System reduced motion, the app preference
and document visibility pause all graphic animations.
