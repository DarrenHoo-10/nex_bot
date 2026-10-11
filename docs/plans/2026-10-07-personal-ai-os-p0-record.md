# Personal AI OS P0 记录

更新：2026-10-10。**现有 P0 夹具的 8 项可执行案例全部通过，原先未验证的 P0-03/04/05 已有真实进程恢复证据。** 本记录描述实验适配器；正式 Core、Device Node 和完整 DDD Repository 尚不在本次改动中。各项的覆盖范围见下表，不能把夹具绿灯等同于所有产品验收条件完成。

夹具在 `server/runtime/pi/p0/`。新恢复实验使用隔离临时目录、SQLite 磁盘库、独立 SDK worker 和 loopback 假模型。子进程只继承运行所需的路径与系统变量，家目录和 Pi 目录均指向临时目录，不继承供应商凭据。测试只结束自己启动的 worker；退出后关闭连接并删除自己创建的临时目录。

## SDK 与适配决定

`@earendil-works/pi-coding-agent` 的导出 VERSION、直接依赖和 lockfile 均为 **1.0.4**，没有修改 node_modules。

发现并修复的恢复接入问题：

1. **首条输入可能没有落盘。** SDK 原生会话文件在只有 custom message 时不会写盘。适配器改用公开 `getHeader/getEntries` 导出，以及 `SessionManager.inMemory(cwd, options, entries)` 导入，由独立 projection.db 事务保存快照。首次输入在联网前即已持久化。
2. **工具异常不能模拟进程崩溃。** 移除旧的“抛错再追加成功”实验。现在监督进程在明确的 IPC 检查点强制结束子进程，确认退出后才领取下一代执行权。
3. **不能混用两层执行生命周期。** 恢复使用公开 `agent.continue`，实时输入使用同层的 `agent.steer`；晚到输入通过 SessionManager 补入后重新 createAgentSession，不直接改写 `agent.state.messages`，不生成虚假的恢复提示词。
4. **批准并不等于已经执行。** 新输入会撤销 pending 或 ready 的旧调用；短等待批准恢复同一 Run，长等待先确认旧 worker 退出，再由新 Run 执行原调用。批准消息本身仍须通过账本状态与参数核对。审批策略持久化在 Core 实验账本，重启后恢复未登记的工具提议仍检查同一策略，不回退到 worker 的默认免审批参数。
5. **授权检查和实际联网之间也有等待窗口。** 模型请求在派发前再次核对 Run；暂停后放开检查点不会发送请求。

事务效果测试使用一个合成计数器：副作用、ToolCall 结果在同一 core.db 事务提交。它证明事务型本地工具的恢复，不声称任意 shell 或外部服务具有 exactly-once 保证。非幂等外部操作仍遵循 unknown/核对协议。

## 当前实测

| 项目 | 结果 | 证据及覆盖范围 |
| --- | --- | --- |
| P0-01 | pass | 诱饵凭据/资源读取为 0；只有 broker 活动工具，内置 bash 被拒绝，系统提示可见 |
| P0-02 | pass | 同来源重投计数仍为 1；新的同参数调用计数变为 2；压缩和重新打开会话保持来源键 |
| P0-03 | pass | 在 assistant 快照后但 Broker 接收前、Core 结果提交后、SDK 结果保存但 Core 未确认时、最终回复保存但输入未消费时，共 4 次强制结束进程；恢复后效果 1 次、SDK 工具结果 1 条；复用已保存回复；旧代次被拒绝 |
| P0-04 | pass | 持久的待审批调用批准前效果为 0；注入时钟验证未满 60 秒不释放、满 60 秒进入释放；实际结束 worker 并确认退出后，新代次恢复相同 call ID、来源和参数；短等待批准继续原代次 |
| P0-05 | pass | 首条输入保存但未确认时崩溃；SDK 内存 steering 队列中的输入崩溃后恢复；ACK 重试保持同 input ID；完成与新消息竞争受版本 CAS 及未消费输入检查保护；3 条输入各消费一次；另有不重启的实时 steering 实验 |
| P0-06 | pass（受控脚本范围） | 主夹具假服务收到 17 次请求，门控记录 17 次；未知 purpose/detail 被拒绝；重试保留 answer 用途。恢复子夹具有独立请求账本，未混入该计数 |
| P0-07 | pass（受控脚本范围） | 取消后旧代次回调不增加工具或网络；次数预算在联网前拒绝；恢复实验另验证实际派发前暂停不联网 |
| P0-08 | pass | openai-completions、anthropic-messages 的文本流、工具参数、图片输入、错误映射 |

60 秒边界使用**注入时钟**推进；worker 的运行、退出与重启是真实进程操作。没有实际等待一分钟，也没有模拟“worker 已退出”的布尔标志替代操作系统退出证据。

P0-03 的进程结束不等同于机器断电测试。快照与业务账本使用 SQLite FULL；存储损坏、突然断电及 Windows/Mac 文件系统差异仍需平台验收。P0-06 的用途由受控脚本指定，尚不代表完整盘点 SDK 一切内部调用；P0-07 未覆盖完整产品 token/时间预算与多 worker 资源调度。这些不是本轮三个恢复用例的阻塞，也不能在正式产品接入时省略。

## 文件与约束

- `recovery-store.ts`：一个可信会话的实验账本，包含持久输入、Task 版本、Run 代次、待审批调用、事务效果和请求覆盖范围；不替代完整 owner-scoped Core Schema。
- `recovery-worker.ts`：仅通过 SDK 公开接口加载、继续、注入及恢复；SDK 快照先于工具授权、网络派发和消费确认保存。
- `recovery.ts`：监督进程、检查点、强制退出和实测断言；新 Run 必须等旧进程 close。
- `recovery-store.test.ts`：首条消息持久化、重复 worker、审批前禁止执行、旧代次拒绝、补充输入作废审批、ACK 重试不作废审批、批准后尚未执行的竞争检查。
- `guards.test.ts`：工具来源三元组去重、参数替换拒绝、精确 loopback origin 与重定向拒绝。

P0 的 projection.db 仅保存模型上下文快照，不保存第二套业务事实。实验对整段 entries 做原子快照；产品适配还需验证长会话的增量存储及性能。Pi 版本、快照格式和迁移兼容性应随 RuntimeSession 一起记录。

先前 CR 修复继续保留：Node TypeScript 兼容、精确网络隔离、同参数独立调用不被合并、OIDC 结束事务清除 secret_ref，以及任一实际用例失败时 CLI 返回非零。

## 复现

```sh
node --experimental-strip-types server/runtime/pi/p0/repro.ts
node node_modules/vitest/vitest.mjs run server/runtime/pi/p0/p0.test.ts server/runtime/pi/p0/guards.test.ts server/runtime/pi/p0/recovery-store.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.server.json --pretty false
node node_modules/oxlint/bin/oxlint --deny-warnings server/runtime/pi
node docs/plans/2026-10-07-personal-ai-os-schema-check.mjs
```

当前实测：复现命令退出码 **0**，8 行均为 pass；Vitest **20 项通过**；后端类型检查和上述 lint 检查退出码 **0**。设计 DDL 的 **65 项契约检查**通过，不作为本实验运行时行为的替代证据。

关键输出：

```text
P0-03 pass hardKills=4 orphanProposalRecovered=1 effects=1 sdkResults=1 resultAckRecovered=1 settledReplyReused=1 staleRunBlocked=1 pausedRequestBlocked=1
P0-04 pass releaseDeltaMs=60000 earlyRelease=0 workerExited=1 preApprovalEffects=0 resumedNewRun=1 sameCall=1 effects=1 shortApprovalSameRun=1 policySurvivesRestart=1
P0-05 pass firstInputCrashRecovered=1 ackRetry=1 queuedSteerCrashRecovered=1 uniqueInputs=3 consumed=3 finishRaceGuarded=1 textNotCommand=1 liveSteerConsumed=1
```

现有 server/index.ts 仍不导入夹具；未设置 NEX_BACKEND 的 legacy 路径保持原状。后续产品实现应遵循[总体方案](2026-10-07-personal-ai-os-identity-and-devices.md)、[领域设计](2026-10-07-personal-ai-os-domain-model.md)及[隔离验证规范](../verification/README.md)。
