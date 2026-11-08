# 多供应商与推理强度：技术方案

日期：2026-11-08。状态：已实施，本地验证见 [验证记录](../verification/model-providers-20261108.md)。

## 目标

1. **设置 → 模型** 改成左边供应商列表、右边详情（参照截图）。可以添加多个供应商，每个供应商有自己的名称、Base URL、API 格式、API Key、启用开关和模型列表。
2. 模型列表里每个模型有启用开关、上下文窗口、是否支持图片输入，以及支持哪些推理档位（低 / 中 / 高 / 很高 / 最高）。列表头部保留 全选 / 全不选。
3. 聊天里的模型菜单：顶部切换供应商，中间选模型，底部是「思考强度」滑块，只列出这个模型支持的档位；不支持推理的模型不显示滑块。每个助手记住自己的供应商、模型和推理强度。
4. Web、Windows（共用 Web）、Mac、iOS 一起改。Android 没有原生模型设置，跟 Web 一致即可。

## 现状

- Core 只存一个供应商：`model_connections` 只读写 `id='default'` 这一行，Key 存在 `secrets` 的 `model-key`（[store.ts:530](../../server/personal-os/store.ts)）。
- 其他按 `(provider, endpoint)` 存的数据已经能区分多个供应商：显示的模型 `model_visibility`、上下文覆盖 `model_limit_overrides`、校准 `model_calibration`、助手模型 `agent_model_settings`。
- 推理固定关闭：worker 注册模型时 `reasoning: false`，会话 `thinkingLevel: "off"`（[worker.ts:358, 383](../../server/personal-os/worker.ts)）。SDK 本身支持 `off | minimal | low | medium | high | xhigh | max`，会转换成 OpenAI 的 `reasoning_effort` 和 Anthropic 的 thinking。
- 几乎所有用模型的地方都经过 `store.modelConfig(botId)`：聊天、后台任务、记忆、上下文压缩。所以在这里解析出「这个助手用哪个供应商、哪个模型、什么推理强度」，后面的调用就都跟着变了。

## 设计

### 数据（迁移 v45）

| 表 | 变化 |
| --- | --- |
| `model_connections` | 不再只有 `default` 一行。新增 `enabled`、`sort_order`。`display_name` 作为供应商名称。现有那一行原样保留，成为第一个供应商，也是默认供应商。 |
| `secrets` | 每个供应商一个 Key：`model-key:<id>`。现有 `model-key` 留给 `default`，不搬数据。 |
| `model_options`（新表） | `(connection_id, model)` → `image_input`、`reasoning_levels_json`、`version`。只存用户改过的；没存的从 models.dev 目录推断：目录标记支持推理的模型默认给 低 / 中 / 高，标记支持图片的默认勾上图片输入。 |
| `agent_model_settings` | 增加 `reasoning` 列，记住每个助手在这个供应商上的推理强度。 |
| `bots.model_connection_id` | 已经存在，改为真正记住助手当前用哪个供应商。 |

- 同一个 API 格式加同一个 Base URL 只允许出现一次，这样上面按 `(provider, endpoint)` 存的表不用改结构。
- 模型的启用开关继续用 `model_visibility`；全选 / 全不选沿用刚做好的逻辑。
- 迁移只加列、加表、补默认值，不改已有行的内容。上线前在生产库的只读副本上跑迁移，逐表核对哈希。

### Core 接口

新增（仅所有者可用，有任务运行时拒绝修改，和现在的 `/api/config` 一样）：

- `POST /api/connections/save`：新建或修改供应商（名称、API 格式、Base URL、Key、启用），带版本号。
- `POST /api/connections/delete`：删除供应商。至少保留一个；用它的助手退回默认供应商。
- `POST /api/connections/default`：设为默认供应商。
- `POST /api/connections/model`：修改某个模型的图片输入和推理档位。
- `/api/models/list`、`/api/models/visibility`、`/api/models/limits`：增加可选的 `connectionId`。

修改：

- `POST /api/bots/model`：增加 `connectionId` 和 `reasoning`。
- `/api/state`：增加 `connections`（每个供应商的名称、格式、地址、是否启用、是否已配置 Key、启用的模型，以及每个模型的上下文、图片输入、推理档位；不含 Key）。每个助手增加 `selected_connection` 和 `selected_reasoning`。

**旧客户端兼容**：已安装的 Windows / Android / Mac / iOS 老版本还会调用旧接口，Core 上线后它们要照常能用。`state.config`、`state.modelVisibility`、`/api/config`、旧格式的 `/api/bots/model` 都保留，统一指向默认供应商。

### 推理强度

- `modelConfig(botId)` 解析出供应商、模型，以及助手选的推理强度。选的档位如果这个模型不支持，就取它支持的最接近的一档。
- worker 注册模型时，对配置了推理档位的模型设 `reasoning: true`，并把档位传给 `thinkingLevel`。SDK 会转换：OpenAI 兼容接口发 `reasoning_effort`，Anthropic 发 thinking 的 budget 或 effort。没有配置档位的模型维持现状，什么都不发，避免不支持的服务直接报错。
- 界面档位对应：关闭 = `off`，低 = `low`，中 = `medium`，高 = `high`，很高 = `xhigh`，最高 = `max`。
- 记忆整理、上下文压缩这些后台调用不开推理，和现在一样。

### Web

- **设置 → 模型**：左栏是供应商列表（名称、启用状态点）和「添加供应商」。右栏是详情：名称、启用开关、Base URL、API 格式、API Key（可显示）、「获取模型」和「添加模型」、模型列表（全选 / 全不选、每行启用开关、上下文和「视觉」标记、编辑、删除）。编辑展开后可以改上下文窗口、最大输出、图片输入，以及推理档位复选框。「…」菜单里有「设为默认」和「删除供应商」。生图模型那一节暂时只跟默认供应商走。
- **聊天模型菜单**（输入框和助手资料里的「驱动模型」共用一个组件）：顶部一行显示当前供应商，点开子菜单切换；中间是这个供应商启用的模型，带「视觉」标记；底部是思考强度滑块。
- 现在设置页里的「模型连接」「显示的模型」「默认模型」合进新页面，不再单独出现。

### Mac 和 iOS

- `NexClientKit`：增加 `Connection`、模型选项和助手选择的协议类型，以及上面的接口调用。
- Mac 的模型设置 `SettingsModelPane`，iOS 的 `SettingsModelView`：改成供应商列表 → 详情。iOS 用列表加推入的详情页，不做左右分栏。
- Mac 的聊天模型弹窗、iOS 的模型选择底部弹窗：加供应商切换和思考强度。

## 不在这次范围

- 生图继续只用默认供应商（而且只支持 OpenAI 兼容接口），不按供应商分开设置。
- 价格、模型别名（「等同于」「列为」）、长上下文价格：截图里有，但当前产品没有计费功能，这次不做。
- 部署、打包和发布：做完先在本地验证，等你说了再走发布流程。

## 验证

- **Core**：迁移测试（v44 库升到 v45 后数据不变，原来的供应商成为默认供应商）；供应商增删改、版本冲突、删除后助手退回默认供应商；`modelConfig` 的解析和档位就近取值；旧接口的兼容。
- **推理强度端到端**：用模拟模型记录请求体，确认 OpenAI 兼容接口发了 `reasoning_effort`、Anthropic 发了 thinking，没配档位的模型什么都不发。
- **Web**：设置页、模型菜单的组件测试；本地隔离预览配两个模拟供应商，实际切换供应商、模型和推理强度，再聊一轮。
- **Mac / iOS**：在 Mac 上用临时目录和专用模拟器编译，跑渲染测试并截图。
- 记录写到 `docs/verification/model-providers.md`。

## 实施顺序

1. Core：迁移、存储、接口、`modelConfig` 解析和测试。
2. Core：推理强度接到 worker，端到端测试。
3. Web：设置页和模型菜单。
4. Mac / iOS。
5. 本地隔离环境整体验证，写验证记录。
