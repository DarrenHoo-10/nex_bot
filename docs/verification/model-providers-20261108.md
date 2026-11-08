# 多供应商与推理强度：本地隔离验证（2026-11-08）

方案：[多供应商与推理强度](../plans/2026-11-08-model-providers.md)。只在本地隔离环境验证，没有部署，也没有打包发布。

## 改了什么

- **Core**
  - 迁移 v45：`model_connections` 增加 `enabled`、`is_default`、`sort_order`；新表 `model_options`；`agent_model_settings` 增加 `reasoning`。原来那一行成为默认供应商，已有行的内容不变。
  - 新接口：`/api/connections/save`、`/default`、`/remove`、`/model`。`/api/models/list` 和 `/api/models/visibility` 可以带 `connectionId`。`/api/bots/model` 可以带 `connectionId` 和 `reasoning`。`/api/state` 增加 `connections`，以及每个助手的 `selected_connection`、`selected_reasoning`。
  - 旧接口照旧可用，指向默认供应商：`/api/config`，以及不带 `connectionId` 的 `/api/bots/model` 和 `/api/models/visibility`。
  - worker 只对配置了推理档位的模型声明 `reasoning`，并传入 `thinkingLevel`。
  - 记忆整理和上下文压缩：配置了记忆模型时，固定走默认供应商。
  - `task_runs.model_connection_id` 记录实际使用的供应商，原来固定写 `default`。
  - 删除供应商是软删除（`status='revoked'`），会清掉它的 Key，用它的助手退回默认供应商。原因是 `task_runs` 有外键指向这张表。
- **Web**
  - 设置 → 模型改成左边供应商、右边详情：名称、Base URL、API 格式、Key、启用、设为默认、删除；模型列表支持全选 / 全不选、启用开关、设为默认模型。编辑模型可以改上下文、最大输出、图片输入和推理档位，没配置过的模型按 models.dev 目录预填。
  - 输入框「＋ › 模型」和助手资料里的「驱动模型」换成同一个菜单：顶部切换供应商，中间是模型（带「视觉」标记），底部是思考强度滑块，只列出这个模型支持的档位，松手才保存。
  - 删除了 `ModelVisibility.tsx`、`ModelLimitsFields.tsx` 和旧的 `ModelSettings`。
- **Mac / iOS**
  - `NexClientKit` 增加 `ModelConnection`、`ModelOptions`、`ReasoningLevel`，以及对应的接口和 `WorkspaceStore` 方法。
  - Mac 设置 → 模型改成左右分栏；iOS 是供应商列表点进详情，编辑模型用表单弹窗。
  - Mac 的模型弹窗、iOS 的模型选择表单增加供应商切换和思考强度。

## 验证

- **Core**：`server/personal-os/connections.test.ts` 共 7 项，全部通过。覆盖：
  - 旧的单连接接口：原连接成为默认供应商，旧版 `bots/model` 照常可用。
  - 从 v44 升级：先把库还原成 v44 结构（删掉新增的列和表，以及迁移记录），再重新打开 Core。迁移重新执行，`model_connections` 和 `agent_model_settings` 已有行逐字段不变，助手原来选的模型和 Key 都在。
  - 供应商的增、改、设默认、删：各自的 Key、重复地址被拒、过期版本被拒、默认供应商不能停用或删除、删除后清掉 Key、助手退回默认供应商。
  - 助手在不同供应商之间切换、旧版本号被拒、停用的供应商自动退回默认。
  - 推理强度端到端，OpenAI 和 Anthropic 各一遍：模拟模型记录请求体。没配档位时不发任何推理参数；配了档位、选「高」后，OpenAI 发 `reasoning_effort: "high"`，Anthropic 发 thinking。
  - 档位就近取值。
- **Core 全量**：536 通过，4 失败，3 跳过。4 项失败分别是 compaction-timing 2 项、image-models 1 项、sender-device 1 项，都在之前记录的「`origin/main` 上同样失败」名单里。其中 image-models 和 sender-device 两项又在上一提交 `dcead93e` 的干净检出上复跑，同样失败。
- **Web**：新增 `ProviderSettings.test.ts`，共 6 项，覆盖设置页和模型菜单。personal 共 135 项，全部通过。`src` 全量 3723 通过、2 失败；这 2 项依赖机器的语言设置（期望英文日期，实际是中文），和本改动无关。
- **typecheck 和 lint**：Web、server 的 typecheck 都通过；`oxlint --deny-warnings` 检查 `server/personal-os` 和 `src/personal`，通过。
- **本地预览**：真实构建的 Core 加 Web，两个模拟供应商，其中一个的模型配了 5 个推理档位，用临时数据和模拟账号。
  - 设置页左右分栏正常显示。
  - 通过菜单把新助手切到第二个供应商，滑块显示「关闭 低 中 高 很高 最高」，拖到「很高」，松手后保存为 `xhigh`。
  - 发一条消息，回复来自第二个供应商。
  - 不支持推理的模型不显示滑块。
- **Mac / iOS**：在 Mac 上用临时目录和专用模拟器，完成后都已删除。
  - Mac Release、iOS 模拟器 Debug、iOS 真机 Release 三个构建都成功。
  - 渲染测试 Mac、iOS 各 15 项，全部通过。
  - 新增 `testModelConnections`：解析 `connections`、选择解析、档位就近取值、菜单标签。在 Mac 上通过。

## 限制

- Mac 和 iOS 的新设置页、模型菜单只编译过，没有截图，也没有手动操作。渲染测试工程只包含 `Shared/` 下的文件，覆盖不到这些界面。
- 推理参数只在模拟模型上验证了请求体，没有接真实服务。某些 OpenAI 兼容服务可能不接受 `reasoning_effort`，所以默认不发，只有在设置里勾了档位的模型才发。
- 生图仍只走默认供应商。
- 有后台任务在运行的助手不能切换模型（原有规则），切换供应商同样受限。
- 没有部署，也没有打包。旧客户端的兼容性只在 Core 测试里验证过，没有用已发布的旧版客户端实测。
