# Mac and iOS: catching up with the web composer and model settings

These web changes had not reached the native apps.

- **Picking an assistant's model.** On Mac, 驱动模型 in the inspector's 设置 tab opened Settings. On iOS, the same row in the agent's 设置 tab did too. Both now open the same picker the composer uses (＋ › 模型). Settings opens only when no model is connected.
- **Model settings order.** The order is now 获取模型列表, then 显示的模型, then 默认模型, with the default picker offering only the visible models (web `ModelSettings`).
- **显示的模型 save at once.** Each check saves immediately, like the web (`ModelSelectionAutosave` in NexClientKit, the counterpart of `useModelSelection`).
  - Writes are serialized: choices made during a save go out with the version that save returned.
  - A failed save reverts to the last confirmed choice and shows "未保存：…".
  - For a connection still being edited, the choice is a draft that is saved right after the connection.
- **生图模型.** The web's image model section (`ImageModelSettings`) now exists on Mac and iOS too, after the connection settings. It is shown for OpenAI-compatible connections and saves each check through `POST /api/models/images`.
- **Stop key.** While the agent works and nothing is typed or attached, the send key becomes the stop key and stops all of the assistant's unfinished tasks.
  - The status line above the composer keeps only its text, as on the web.
  - The Mac menu command 停止当前任务 (⌘.) is unchanged.
- **Pasting images.**
  - Mac: ⌘V in the composer attaches a clipboard picture as PNG, or a copied picture file under its own name. Text still pastes normally.
  - iOS: the ＋ menu has 粘贴图片, the system paste button, so there is no "允许粘贴" prompt. The text field itself still pastes text only.
  - Pending pictures show a thumbnail in their chip on both.
- **Mac packaging.** `apps/apple/scripts/release-preview.sh` now stages the device executor from the checkout (`scripts/build-mac-executor.mjs`). Before this, Xcode bundled whatever `apps/apple/build/Executor` held. 0.2.5's copy matched `main`, but only by chance.

## Checks

- `swift test` in `apps/apple/Packages/NexClientKit`: 111 tests. `ModelSelectionAutosaveTests` covers:
  - saving with the stored version;
  - serialized writes during a save;
  - reverting after a failure;
  - adopting newer values from another device;
  - decoding `imageModelSelection`.
- `NexBotMac` and `NexBotiOS` Debug builds succeed.
- AppKit composer checks pass (`ComposerTextEditor: 7 checks passed`). They use a private pasteboard, so the user's clipboard is not touched. Run:

  ```sh
  cd apps/apple
  xcrun swiftc -parse-as-library -swift-version 6 NexBotMac/ComposerTextEditor.swift Tests/ComposerTextEditorChecks.swift -o /tmp/cte && /tmp/cte
  ```

- **Mac walkthrough** against `scripts/fixture-native-client.mjs` (synthetic Core, `fixture-*` profile):
  - The picker opened from 驱动模型 and listed `fixture-model` and `fixture-reasoning`.
  - An attached PNG showed its thumbnail and uploaded (`red.png:ok`).
  - During a streamed reply the send key was the stop key.
  - Settings › 模型 showed the new order.
  - Unchecking a visible model saved at once: stored version 0 → 1, then 2 when checked again.
  - Checking an image model saved it: version 0 → 1, `fixture-model`.
- **iOS Simulator walkthrough** against the same fixture:
  - The stop key appeared during a streamed reply.
  - The picker sheet opened from 驱动模型. After a visible model was unchecked, it offered only the remaining one.
  - Settings › 模型 showed the new order and the 生图模型 card. Both saves were confirmed by the same version logs as on Mac.

DEBUG-only hooks used:
- Mac:
  - `NEXBOT_FIXTURE_MEMORY_CREDENTIALS=1` keeps the session in memory, only for `fixture-*` profiles. The Keychain returns -25308 while the screen is locked.
  - On `$NEXBOT_DEBUG_COMMAND_FILE.b`:
    - `im model` / `im close` open and close the picker;
    - `ig toggle <id>` / `ig status` act on 生图模型;
    - `snap <prefix>` writes every app window, popovers included, to PNG, and works while the screen is locked.
- iOS: on `NEXBOT_DEBUG_UI_FILE`:
  - `agentmodel` / `closemodels` open and close the picker;
  - `ig-toggle <id>` / `ig-status` act on 生图模型.

## Not exercised here

- iOS 粘贴图片: the system paste button only responds to a real tap.
- Real ⌘V in the running Mac app: the AppKit checks cover `paste(_:)` itself.
- Pasting images on Android: depends on the keyboard.
