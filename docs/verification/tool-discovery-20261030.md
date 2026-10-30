# Common tools and on-demand discovery — local verification

The user chose short resident instructions for common tools, with Todo explicitly
classified as common. Uncommon tools should be queried when needed rather than
adding another full manual to the system prompt.

`server/personal-os/tool-catalog.ts` holds each action's title, fields, required
arguments and detailed help. An optional `brief` marks a common action. The initial
common set covers Todo, memory search/read/write, peer directory/delegation,
device inventory/file reads/listing/commands and attachments. Only authorized
briefs enter the system prompt. General safety and success-reporting rules stay
resident. Full scheduling, image, HTML/chart, GUI, connector, profile and memory
organization instructions are returned on demand.

`broker({action:"tool.search",query})` accepts a purpose keyword, action prefix or
exact action. Exact names return only that action; empty queries return compact
directory entries. Results have `nextOffset`; pages default to 5, maximum 10.
Nonempty queries include action-specific JSON Schema and operating rules. The
read-only discovery action is available to active Agents but only returns their
current grants (including the existing memory-write aliases). It does not grant
any discovered capability. Execution still checks policy and resource scope.

The Broker wire declaration is compact and keeps the existing flat argument
format. The previous full field-type schema is retained locally in
`server/personal-os/tool-fields.ts`; the worker checks it before forwarding a
proposal. Core's existing action-specific validation and approvals remain intact.
Web and Apple capability labels/catalogs include the discovery action.

## Size evidence

Using the repository's conservative `server/personal-os/token-estimate.ts`, not
provider billing or a claim about the whole conversation:

| Compared content | Before | After |
| --- | ---: | ---: |
| Broker declaration, including parameter schema | 3,381 | 186 |
| Replaced resident tool-instruction block | 3,350 | 937 |
| Common-tool briefs plus discovery guidance | — | 577 |
| Three Todo briefs | — | 126 |

Identity, memory, directories and conversation history are excluded from the
instruction-block comparison. Queried help consumes context when used. Local
baseline sources and calculations are in ignored `release/tool-discovery-evidence/`.

## Verification

All model and server mutations used synthetic providers and temporary databases.

- `server/personal-os/tool-catalog.test.ts`: 5 passed. Includes paginated catalog
  completeness, exact/Chinese-purpose lookup, schemas, no-match/invalid queries,
  policy changes, restricted and archived Agents, resident-size bounds, and real
  OpenAI/Anthropic worker journeys: discover `routine.save`, receive its schema,
  create a plan. First requests omit the rare parameters; following requests
  contain them. Wrong-type Todo calls are rejected before reaching Core.
- `server/personal-os/todos.test.ts`, `server/personal-os/html-render.test.ts`,
  `server/personal-os/policy-defaults.test.ts`: 17 passed. Todo calls remain direct;
  HTML help is queried before publication and still carries isolation rules.
- `server/personal-os/topic-access.test.ts`: 19 passed.
- `server/personal-os/app.test.ts`: 44 passed, one existing skip, counting the
  focused rerun after updating its expected universal-action list to include
  `tool.search`. The other 43 tests passed in the preceding full run.
- Frontend/server TypeScript, changed-file lint and Core/Web build passed. The
  existing large-bundle warning remains.
- On the Mac, all 180 NexClientKit tests passed with the new catalog and labels
  in a fresh temporary source directory; that directory was removed.

## Limits

Scripted providers verify transport, discovery and execution contracts; they do
not measure a live model's search/selection quality or real-provider schema
acceptance. Search is deterministic keyword matching, with an empty-query
directory fallback. Apple checks cover the shared package, not native interactive
testing or installers. No schema migration, version bump, push, production
deployment, GitHub/OSS publication or update-manifest change was made.
