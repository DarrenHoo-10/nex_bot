# Sending-device context

Verified 2026-10-18 in disposable Core data. All identities and messages were
synthetic; no live account data was read or changed.

The assistant learns which client the user is messaging from through the
`device.inventory` tool, not the system prompt. Its result now has
`currentClient: { name, deviceId }` for the latest accepted message of the task:
`deviceId` is the device that client paired (Windows or Mac executor), or `null`
when the client is not a device (Android, iOS). Tasks without a client session
(routines) get `currentClient: null`. The tool description says the `deviceId` is
the default target for files and commands when the user names no device, and to ask
when it is `null`. The system prompt is unchanged.

Schema 18 adds `devices.session_id`. `POST /api/devices` records the session whose
token paired the device, so existing Windows and Mac clients need no update.
Devices paired earlier are linked only when exactly one live session carries the
same client name; otherwise they stay unlinked until the client signs in again.
The client name is stripped of control characters and cut to 80 characters.

Commands:

```sh
pnpm exec vitest run server/personal-os/sender-device.test.ts
pnpm exec vitest run server/personal-os
pnpm typecheck
pnpm lint
```

Results: 3 new tests and the 144 server tests passed; type checking and lint passed.
The tests run the scripted model's real `device.inventory` call and read the tool
result: a Mac session with a bound online device gives its `deviceId`; a phone
session gives `null`; the same Mac while offline keeps its `deviceId` with
`online: false` in `devices`; control characters are stripped; a task whose client
session is gone gives `null`; migration 18 is idempotent and backfills only on a
unique live session name.

Earlier in the same change, with a prompt-line variant of this feature, the fixture
Core plus the Debug macOS app (throwaway profile) showed the Mac's own executor
device linked to the Mac's session and the Core host device left unlinked.
That linkage code is unchanged, but the final tool-based version was not re-run
against the native app.

Not verified: a real model's choice to call `device.inventory` and use
`currentClient`, Windows and Android clients, or a deployed Core. The change takes
effect only after Core is rebuilt and redeployed.
