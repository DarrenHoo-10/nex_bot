# Mac and iOS: model choice, model settings order and pasted images

These web changes had not reached the native apps:

- **Picking an assistant's model.** On Mac, 驱动模型 in the inspector's 设置 tab opened Settings. On iOS, the same row in the agent's 设置 tab did too. Both now open the same picker the composer uses (＋ › 模型). Settings opens only when no model is connected.
- **Model settings order.** The order is now 获取模型列表, then 显示的模型, then 默认模型, with the default picker offering only the visible models (web `ModelSettings`).
  - For the saved connection, 显示的模型 still saves with its own button.
  - For a connection still being edited, the choice is a draft that is saved right after the connection.
- **Pasting images (Mac).** ⌘V in the composer attaches a clipboard picture as PNG, or a copied picture file under its own name. Text still pastes normally. Pending pictures show a thumbnail in their chip on Mac and iOS. iOS adds pictures through 照片; pasting into the iOS text field was not changed.

## Checks

- `swift test` in `apps/apple/Packages/NexClientKit`: 106 tests.
- `NexBotMac` and `NexBotiOS` Debug builds succeed.
- AppKit composer checks pass (`ComposerTextEditor: 7 checks passed`). They use a private pasteboard, so the user's clipboard is not touched. Run:

  ```sh
  cd apps/apple
  xcrun swiftc -parse-as-library -swift-version 6 NexBotMac/ComposerTextEditor.swift Tests/ComposerTextEditorChecks.swift -o /tmp/cte && /tmp/cte
  ```

- Mac walkthrough against `scripts/fixture-native-client.mjs` (synthetic Core, `fixture-*` profile):
  - The model picker opened from 驱动模型 and listed `fixture-model` and `fixture-reasoning`.
  - An attached PNG showed its thumbnail and uploaded (`red.png:ok`).
  - Settings › 模型 showed the new order.

  DEBUG-only hooks used:
  - `NEXBOT_FIXTURE_MEMORY_CREDENTIALS=1` keeps the session in memory, only for `fixture-*` profiles. The Keychain returns -25308 while the screen is locked.
  - `im model` / `im close` open and close the picker.
  - `snap <prefix>` writes every app window, popovers included, to PNG. It works while the screen is locked.

  Both commands go to `$NEXBOT_DEBUG_COMMAND_FILE.b`.
