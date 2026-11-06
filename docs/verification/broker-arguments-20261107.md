# Broker 参数契约：本地隔离验证（2026-11-07）

## 范围与来源

- 开始时执行 `git fetch origin main`，工作树 HEAD 与 `origin/main` 均为
  `19609f3428561cb48d8c11f6ebbd7fc1eaf4cda5`，左右差异为 `0 / 0`。
- 本次只修改工具输入契约、字段诊断和回归；不混入工作面板 UI 改动。
- 以下隔离验证阶段未提交、推送、部署或调用真实收费模型，也没有访问或修改生产数据。
  验证完成后，用户另行明确授权“改完后直接发布部署吧”，继续进行 Core-only 发布；
  正式部署证据另行记录。此前发布的真实模型行为仍须另行授权验证。

## 已知现象与归因边界

调查任务提供了 Tokyo `31b25797` 发布版的只读数据库证据：

- 模型名为 `grok-4.7-build-fast`；写文章请求的 `job.start` 实际参数只有
  `{"action":"job.start"}`，没有 `title`，因此创建失败。
- 后续八次 `tool.search` 也都只有 `action`，没有 `query / offset / limit`。
  每次都按默认值执行，返回同一第一页（`total=39,nextOffset=5`）。
- 两次请求均未创建后台任务；runtime projection 中的解析后参数与 Core 调用记录一致。
- **没有上游原始 HTTP 响应。** 本会话未重新查询生产。因此不能把这些证据
  改写为“模型只输出了 action”或“适配器已被证明剥掉了字段”。

本地代码核查确认：此前唯一的 broker wire schema 只有
`Type.Object({action: Type.String()}, {additionalProperties: true})`。
其余字段仅在本地 `tool-fields.ts` 校验和 `tool.search` 的文本结果中出现。
这是可确认的输入契约缺口；它本身并不证明生产缺参的唯一上游原因。
缺 `title` 导致创建失败、缺翻页参数导致默认第一页，是已确定的 Core 行为。

### 实际 SDK 路径

worker 将自定义 provider 注册为 `nex`；OpenAI-compatible 配置走
`openai-completions`，Anthropic 配置走 `anthropic-messages`。本次锁定版本为
`pi-coding-agent / pi-agent-core / pi-ai 1.0.4`，其 OpenAI SDK 为 `7.19.0`。
SDK 使用 TypeBox `1.3.27`，应用自己的 TypeBox 为 `1.3.7`。

在被核查的 OpenAI-compatible 路径中：

- 工具 schema 会进行 JSON 序列化，但不会通用地删除未声明的参数；默认不启用
  strict mode。本地合成 HTTP 请求确认 `function.strict` 未发送。
- provider 累积参数片段并解析/修复 JSON；存下的是解析后对象，不是原始 HTTP 字符串。
- `validateToolArguments` 对参数 `structuredClone`，移除声明为可选且不接受 null 的
  null 字段，再执行 `Value.Convert`。例如数值 `title:123` 可以被转换为字符串。
  SDK 把此副本交给 execute，而原始 assistant toolCall 保留原值。
- Core 用规范化 JSON 比较执行参数与 assistant 来源参数。不应通过放松这一检查
  来接受 SDK 的静默转换。

本机离线探针直接调用该版本 `validateToolArguments`：旧 action-only schema 下，
完整的合成 `job.start` 参数未被剥除；新字段 schema 下的 `title:123,note:null`
被 SDK 副本变成 `title:"123"`，而原始对象仍保留数值和 null。
这也复现了为何补 schema 必须同时修正 worker 的参数来源。

因此没有发现可据以认定生产事故由本地 SDK“通用剥参”造成的证据。
真实上游模型、代理的 schema 处理，以及不完整/畸形流式响应仍未验证。

## 修改

1. `broker-tool.ts` 直接复用 `toolFields`，在发给 provider 的真实 schema 中声明
   全部 66 个字段及类型，包括 `title / sources / note / query / offset / limit`。
   保持旧的顶层扁平调用格式，不增加另一层未声明的参数袋。
2. 保留按需发现：常用简述仍驻留；罕见操作的说明、每个 action 的必填项和操作规则
   仍由 `tool.search` 返回。没有把完整工具手册塞回系统提示。
3. worker 从本次 assistant 的 broker toolCall 读取原始解析参数，校验并原样转发。
   不使用 SDK 转换后的副本；数字字符串转换、可选 null 删除不会改变 Core 实际授权的
   参数。类型错误给出字段路径，例如 `/title`、`/offset`、`/note`。
4. Core 在通过现有授权检查后、执行 action 前，按 catalog 的必填项返回可诊断错误。
   例如 `job.start` 缺标题返回 `code=invalid_tool_arguments,action=job.start,fields=[title]`，
   并说明应把参数放到 broker 顶层及如何查询用法。该失败保留在调用记录里，不创建任务。
   条件必填、值域、长度及资源权限仍由原处理器负责。
5. `job.start` 的按需说明明确：这是同一助手的独立后台执行上下文，不是另一位已有
   联系人，也不完整继承主对话历史。发现关键词增加“子代理 / 子agent / subagent”。

保守离线估算（不是供应商计费数据）：broker declaration 从 **186** 增至
**1,038 tokens**；增加的是必要的机器输入契约。上下文预算继续引用同一 declaration，
不会漏计新增 schema。测试限制声明低于 1,400 tokens，且每个 catalog 字段都必须有
wire schema，防止再回退成 action-only。

## 隔离回归

所有新回归均由 `createPersonalApp` 启动临时 Core 和真实 forked worker，使用
loopback 合成模型、随机测试密钥、临时数据库；关闭真实身份、设备和模型目录网络获取。
结束后关闭模型、Core 和子进程并删除各自临时数据。

`server/personal-os/tool-catalog.test.ts`：

- OpenAI-compatible、Anthropic 的实际 HTTP 请求都含完整 broker schema；
  首次请求仍不带罕见 action 的操作手册，查询后才出现。
- 默认目录、`offset=0,limit=3`、`offset=3,limit=3`、`query=job.start,limit=1`
  均通过真实 worker。两页无重复，`nextOffset` 分别为 3 和 6；精确查询只返回派发动作。
- 合成响应的参数、Core `arguments_json` 和 runtime projection 参数逐项相等。
- 查询 `routine.save` 后仍可执行罕见动作；其字段在 Core 不丢失。
- 错误类型 `title:123`、`offset:"3"` 和 `note:null` 都被拒绝，下一次模型请求
  能看到字段诊断，不出现 `Tool source mismatch`，也不产生待办或后台任务。
- 空白/缺少标题可诊断；`tool.search` 的可选参数仍可省略，`false` 和 `0` 不被误判为缺失。

`server/personal-os/jobs.test.ts`：

- 两种协议均先发送 action-only `job.start`，收到明确的 title 错误；再发现用法，
  发送包含 `title / sources / note` 的正确调用。
- Core 记录第一次失败和第二次成功，恰好创建一个后台任务；完整参数与 projection 一致。
- 后台任务属于同一 bot、使用不同 Conversation，没有创建额外联系人；用户原话和备注
  到达后台，短文报告只发布一次。报告、并行、审批、停止、恢复和设备隔离旧回归继续覆盖。

构建后验证使用现有 `scripts/smoke-core-service.mjs`，启动刚构建的
`dist-personal/server/core/service.js`，所有身份与模型端点也是本机合成服务。
它验证真正打包的 worker、认证、单写者、端口冲突、重启、注销和关闭，
不是用该 smoke 的纯文本响应替代上面的参数链路测试。

## 验证命令与结果

- `pnpm exec vitest run server/personal-os/tool-catalog.test.ts`：8/8 通过。
- `pnpm exec tsc -p tsconfig.server.json --noEmit`：通过。
- `node scripts/build-personal.mjs --core`：通过（既有前端 chunk 大小警告仍存在）。
- `node scripts/smoke-core-service.mjs`：13/13 检查通过。
- 扩展回归：9 个测试文件通过，**138 passed / 1 skipped**。唯一跳过是
  `app.test.ts` 的旧 0.4 迁移测试，未提供 `NEX_TEST_LEGACY_04_BUNDLE`。
- `pnpm typecheck`：前端与服务端均通过；本次修改的七个 TS 文件 oxlint 通过。
- `git diff --check`：通过。构建引起的 Apple HTML 资源纯行尾改动已撤回，没有客户端改动。

扩展回归命令：

```bash
pnpm exec vitest run \
  server/personal-os/tool-catalog.test.ts server/personal-os/jobs.test.ts \
  server/personal-os/app.test.ts server/personal-os/todos.test.ts \
  server/personal-os/routine-isolation.test.ts server/personal-os/routines-isolation.test.ts \
  server/personal-os/connectors.test.ts server/personal-os/cache-retention.test.ts \
  server/personal-os/model-limits.test.ts
```

本地日志及 SDK 探针结果保存在忽略目录 `release/broker-arguments-evidence/`：
`regression.log`、`typecheck-lint.log`、`build.log`、`service-smoke.log`、`sdk-probe.json`。
早期测试检查发现的两处测试类型标注问题已修正；以上均为修正后的最终结果。

## 限制

- 合成模型按脚本输出，证明的是 schema、传输、校验、派发、持久化和反馈闭环，
  **不是**真实 Grok 会自主正确选择工具、生成参数或撰写文章的质量证明。
- 未取得事故原始响应；未调用真实收费模型，也未测试实际代理对 schema 的接受情况。
- 没有改动客户端 UI；未运行 Mac/iOS/Android/Windows 安装包验收或发布流程。
- 没有执行数据迁移，没有改线上对话、任务、服务、manifest 或下载入口。
- 本地构建不代表发布；GitHub 和 OSS 发布均未执行。
