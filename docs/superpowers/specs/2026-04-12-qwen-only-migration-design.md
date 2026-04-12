# Qwen Only Migration Design

| 项目 | 内容 |
|---|---|
| 日期 | 2026-04-12 |
| 目标 | 将当前应用从 iFlow ACP 接入切换为仅支持 Qwen Code |
| 范围 | Agent 启动链路、ACP 传输层、历史会话读取、技能目录扫描、前端文案与默认值 |
| 非目标 | 保留 iFlow 运行时兼容、保留 iFlow 历史读取、重写前端架构、引入新的 Agent 抽象体系 |

## 背景

| 项目 | 内容 |
|---|---|
| 当前状态 | 应用当前通过 `iflow --experimental-acp --port <port>` 启动 iFlow，再用 `ws://127.0.0.1:<port>/acp` 建立 ACP WebSocket 连接 |
| 现有问题 | iFlow 后续已无法继续使用，当前接入方式失去维护价值 |
| 替代方案 | 本机已安装 `qwen 0.14.2`，其 CLI 支持 `--acp`、`--model`、`--continue`、`--resume` |
| 关键差异 | Qwen ACP 使用 `stdio` 传输，而非当前代码依赖的 WebSocket + 端口模式 |

## 目标结果

| 项目 | 结果 |
|---|---|
| Agent 类型 | 统一为 `qwen` |
| CLI 启动 | 后端使用 `qwen --acp` 启动子进程 |
| 工作目录 | 继续使用用户在前端选择的 workspace 作为当前目录 |
| 模型参数 | 连接时继续支持传入模型，映射到 `qwen --model <name>` |
| 会话链路 | 保留现有 `initialize -> session/new/session/load -> session/prompt -> session/cancel` 的 ACP 业务流程 |
| 历史来源 | 仅读取 `~/.qwen/projects/<workspace-key>/chats/*.jsonl` |
| 历史文件名 | 使用 `<session-uuid>.jsonl`，不再沿用 `session-*` 前缀假设 |
| 技能来源 | 仅扫描 `~/.qwen/skills` |
| UI 文案 | 所有用户可见的 `iFlow` 默认文案改为 `Qwen` |

## 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 方案 1 | 直接把后端 ACP 传输层从 WebSocket 改为 Qwen `stdio ACP` | 改动集中，能复用现有前端与大部分 ACP 状态机 | 需要替换传输实现 | 采用 |
| 方案 2 | 在本地加一层 stdio 到 WebSocket 的桥接 | 可表面复用更多旧监听代码 | 多一层协议桥，调试和维护成本高 | 不采用 |
| 方案 3 | 从零重写 Agent 接入层与历史层 | 命名和架构最干净 | 变更面过大，回归风险高 | 不采用 |

## 总体设计

| 模块 | 当前行为 | 调整后行为 |
|---|---|---|
| 后端 Agent 启动 | 直接启动 iFlow，绑定端口，依赖 WebSocket ACP | 直接启动 `qwen --acp`，通过子进程 `stdin/stdout` 进行 ACP JSON-RPC 通信 |
| ACP 传输层 | `src-tauri/src/agents/iflow_adapter.rs` 负责 WebSocket 连接与收发 | 替换为 Qwen `stdio ACP` 适配层；移除 WebSocket 内部重试循环，失败后直接退出，由前端重新触发完整 spawn |
| 历史读取 | 从 `~/.iflow/projects/.../session-*.jsonl` 读取 | 仅从 `~/.qwen/projects/.../chats/*.jsonl` 读取 |
| 技能发现 | 扫描 `~/.iflow/skills` | 仅扫描 `~/.qwen/skills` |
| 模型列表 | 通过解析 iFlow bundle 静态提取模型列表 | 以 `session/new` / `session/load` 返回的 `models` 字段和后续 ACP 配置更新为主要来源；删除静态 bundle 解析链路 |
| 前端文案 | “添加 iFlow Agent”“iFlow CLI 路径”等 | 统一替换为 Qwen 对应文案 |

## 模块级设计

### 1. 后端命令层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` | 将 `spawn_iflow_agent` 重命名为 `spawn_qwen_agent`，并改为基于 Qwen 的启动逻辑；不再申请端口 |
| `src-tauri/src/commands.rs` | 将 `connect_iflow` 重命名为 `connect_qwen`，`switch_agent_model` 重命名为 `switch_qwen_model`，相关调用方全部同步更新 |
| `src-tauri/src/state.rs` | `AgentInstance` 中的 `iflow_path` 重命名为 `qwen_path`；删除 `port` 字段 |
| `src-tauri/src/models.rs` | `AgentInfo.agent_type` 固定为 `qwen`，相关类型名与字段命名同步去除 `iflow`；`ConnectResponse` 删除 `port` 字段 |
| `src-tauri/src/model_resolver.rs` | 删除整个文件；不再保留 iFlow 静态模型解析逻辑 |
| `src-tauri/src/main.rs` | `generate_handler!` 中所有公开 Tauri 命令名同步改为 `qwen` 语义，不保留 `connect_iflow` 这类跨边界旧名称 |

### 2. ACP 适配层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agents/iflow_adapter.rs` | 文件重命名为 `src-tauri/src/agents/qwen_adapter.rs`，并替换为 Qwen `stdio ACP` 适配实现 |
| `src-tauri/src/agents/session_params.rs` | 继续复用，前提是 Qwen ACP 的请求结构与当前使用方式兼容 |
| `src-tauri/src/router.rs` | 尽量不改业务路由，只在必要时适配 Qwen 返回的 payload 差异 |
| `src-tauri/src/agents/mod.rs` | 模块导出从 `iflow_adapter` 改为 `qwen_adapter` |
| WebSocket 辅助函数 | 删除 `find_available_port()` 及所有端口相关调用 |

### 2.1 stdio 传输实现

| 项目 | 设计 |
|---|---|
| 子进程启动 | 使用 `tokio::process::Command` 启动 `qwen --acp`，并显式获取 `stdin`、`stdout`、`stderr` |
| 帧格式 | Qwen ACP 基于 `@agentclientprotocol/sdk` 的 `ndJsonStream`，采用 `NDJSON`：每条消息为一行 `JSON + "\\n"`，不是 `Content-Length` 报文 |
| 消息发送 | 通过子进程 `stdin` 写入 ACP JSON-RPC 消息，按 `JSON.stringify(message) + "\\n"` 逐条写入并 flush |
| 消息接收 | 通过 `tokio::io::BufReader` 包装 `stdout`，按行读取并逐行 `serde_json` 解析 |
| stderr 处理 | `stderr` 不参与 ACP 协议，仅作为日志流异步消费，避免缓冲区阻塞导致子进程挂起；日志输出不能混入 `stdout` 解析通道 |
| 子进程退出 | 使用 `tokio::spawn` 启独立任务执行 `child.wait()`；一旦退出，统一向前端发错误事件并清理 inflight 状态 |
| 连接关闭 | 当 `stdout` EOF、`stdin` 写失败或 wait 任务先结束时，都视为 ACP 连接断开 |
| 失败语义 | `message_listener_task` 在 stdio 模式下不做内部重试，发生错误后直接退出 |
| 重连职责 | 重连仅由前端显式调用 `connect_qwen` 重新触发完整 spawn 流程；自动重连逻辑继续放在 `features/agents/reconnect.ts` |

### 2.2 Qwen Agent 可能发起的 Client Request

| 方法 | 用途 | 首阶段处理 |
|---|---|---|
| `session/request_permission` | 请求用户授权工具调用 | 继续沿用当前“allow_once”自动响应逻辑 |
| `fs/read_text_file` | 读取客户端文件 | 继续支持 |
| `fs/write_text_file` | 写入客户端文件 | 继续支持 |
| `terminal/create` | 创建终端任务 | 首阶段若前端未接入终端能力，则返回 method not found 或显式错误 |
| `terminal/output` | 终端输出流交互 | 同上，首阶段不实现 |
| `terminal/kill` | 终止终端任务 | 同上，首阶段不实现 |
| `terminal/release` | 释放终端句柄 | 同上，首阶段不实现 |
| `terminal/wait_for_exit` | 等待终端退出 | 同上，首阶段不实现 |
| `ext/*` | 扩展方法 | 未明确需要时默认不实现 |
| `_iflow/user/questions` | iFlow 私有方法 | 迁移时删除对应 handler |
| `_iflow/plan/exit` | iFlow 私有方法 | 迁移时删除对应 handler |

### 2.3 首阶段 Client Capability 边界

| 能力 | 决策 |
|---|---|
| 文件读写 | 保留，确保 Qwen 的基本代码编辑链路可用 |
| 权限请求 | 保留，兼容工具调用前授权 |
| 终端类请求 | 首阶段不实现，除非验证发现 Qwen 主流程强依赖 |
| 扩展方法 | 按需实现，不在首阶段承诺 |

### 2.4 initialize capabilities

| 项目 | 设计 |
|---|---|
| `clientCapabilities.fs` | 保留 `readTextFile` / `writeTextFile` |
| `clientCapabilities.terminal` | 首阶段不声明，省略即表示不支持 |
| 兜底行为 | 若 Qwen 仍发送 `terminal/*` 请求，客户端返回 method not found 或显式 unsupported 错误 |

### 3. 历史会话层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/history.rs` | 保留文件位置，但内部所有 `iflow` 历史函数与辅助函数统一重命名为 `qwen` 语义，并改为基于 `~/.qwen/projects/<workspace-key>/chats/*.jsonl` 的解析 |
| 历史内容提取 | 按 Qwen `message.parts` 数组解析，仅提取有 `text` 的条目；忽略 `functionCall` 等无法稳定映射的结构化条目 |
| 历史会话名 | 优先使用首条用户消息压缩为标题，不追求还原所有系统事件；空标题 fallback 改为 `Qwen 会话` |
| Session ID 归一化 | 直接使用文件名去掉 `.jsonl` 后的 UUID，不再校验 `session-` 前缀 |

### 3.0 历史命令与函数重命名

| 原名称 | 新名称 |
|---|---|
| `normalize_iflow_session_id` | `normalize_qwen_session_id` |
| `parse_iflow_history_summary` | `parse_qwen_history_summary` |
| `parse_iflow_history_messages` | `parse_qwen_history_messages` |
| `list_iflow_history_sessions` | `list_qwen_history_sessions` |
| `load_iflow_history_messages` | `load_qwen_history_messages` |
| `delete_iflow_history_session` | `delete_qwen_history_session` |
| `clear_iflow_history_sessions` | `clear_qwen_history_sessions` |

### 3.1 Qwen 历史文件结构

| 字段 | 说明 |
|---|---|
| 顶层 `type` | 使用 `user` / `assistant` 作为主要可展示消息类型 |
| 顶层 `sessionId` | 与 JSONL 文件名一致，可用于历史会话加载 |
| `message.parts` | 为数组结构，不再假设存在 iFlow 样式的 `message.content` |
| `parts[].text` | 作为主文本来源 |
| `parts[].thought` | 若存在且为 `true`，表示思考内容；首阶段历史面板默认不单独展示 |
| `parts[].functionCall` | 视为结构化工具信息，首阶段忽略，不写入普通聊天消息 |

### 3.1.1 Qwen JSONL 样例

```json
{"sessionId":"464a05db-d441-44fb-a696-f920a0e49ae4","timestamp":"2026-03-23T05:25:08.744Z","type":"user","cwd":"/Users/chenweilong/playground","message":{"role":"user","parts":[{"text":"@hello-world.html 这个文件内容是什么?"}]}}
{"sessionId":"464a05db-d441-44fb-a696-f920a0e49ae4","timestamp":"2026-03-23T05:25:14.033Z","type":"assistant","cwd":"/Users/chenweilong/playground","message":{"role":"model","parts":[{"text":"The user is asking about a file...","thought":true},{"text":"The `hello-world.html` file is a simple HTML page..."}]}}
```

| 解析规则 | 说明 |
|---|---|
| 排序时间 | 使用记录里的 `timestamp`，不需要退化到文件修改时间 |
| workspace 关联 | Qwen 记录内实际存在 `cwd`，但首阶段仍以 project 目录名作为主匹配依据，`cwd` 作为校验与兜底信息 |
| user 消息 | 拼接 `parts[].text` |
| assistant 消息 | 默认只保留非 `thought` 文本；是否展示 thought 单独由 UI 决定 |
| system 消息 | 如 `ui_telemetry`、`at_command`，首阶段不进入聊天历史 |

### 3.2 Project Key 规则

| 项目 | 规则 |
|---|---|
| 基本规则 | 将 workspace 绝对路径中的 `/`、`:` 替换为 `-` |
| 前缀规则 | 若转换后不以 `-` 开头，再补一个前导 `-` |
| 当前工作区示例 | `/Users/chenweilong/www/FlowHub` -> `-Users-chenweilong-www-FlowHub` |
| 复用策略 | 复用现有 `workspace_to_iflow_project_key` 逻辑并重命名为 `workspace_to_qwen_project_key` |

### 4. 技能发现层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` 中技能扫描逻辑 | 根目录从 `~/.iflow/skills` 切换为 `~/.qwen/skills`，相关 helper 名称同步去除 `iflow` |
| 前端 `discoverSkills` 结果 | `agentType` 改为 `qwen`，其余结构保持兼容 |

### 5. 前端表现层

| 文件 | 改动 |
|---|---|
| `index.html` | 弹窗标题、占位符、默认 Agent 名称、CLI 路径说明统一改为 Qwen |
| `src/features/agents/actions.ts` | 新增 Agent 时默认 `agent.type = "qwen"`，ID 前缀、成功提示、加载提示同步切换 |
| `src/features/agents/reconnect.ts` | 自动重连入口改为调用 `connectQwen`；重连语义明确为“重新 spawn Qwen 进程”，而不是重连底层传输 |
| `src/services/tauri.ts` | 所有 Tauri 调用名同步重命名为 `qwen` 语义，不保留 `iflow` 包装层 |
| `src/types.ts` | `source`、类型注释和字面值统一从 `iflow` 改为 `qwen`；删除 `iflowPath` / `port` 语义 |
| 默认 CLI 路径 | 添加 Agent 弹窗中的默认占位提示从 `iflow` 改为 `qwen` |

### 5.1 前端 Tauri 调用重命名

| 原名称 | 新名称 |
|---|---|
| `connectIflow` | `connectQwen` |
| `clearIflowHistorySessions` | `clearQwenHistorySessions` |
| `listIflowHistorySessions` | `listQwenHistorySessions` |
| `loadIflowHistoryMessages` | `loadQwenHistoryMessages` |
| `deleteIflowHistorySession` | `deleteQwenHistorySession` |
| `switchAgentModel` | `switchQwenModel` |

### 5.2 前端类型字段重命名

| 原名称 | 新名称 |
|---|---|
| `Agent.iflowPath` | `Agent.qwenPath` |
| `Agent.port` | 删除 |
| `Session.source: 'iflow-log'` | `Session.source: 'qwen-log'` |

## ACP 数据流

| 阶段 | 设计 |
|---|---|
| 启动 | 前端传入 `agentId + qwenPath + workspacePath + model`，后端启动 `qwen --acp` |
| 初始化 | 后端建立 stdio 读写循环后发送 `initialize` |
| 新会话 | 无恢复目标时发送 `session/new`，并从响应里的 `models` / `configOptions` 初始化前端模型状态 |
| 恢复会话 | 有历史会话 ID 时发送 `session/load`，并复用返回的 `models` / `configOptions` |
| 发送消息 | 保持使用 ACP `session/prompt` |
| 停止生成 | 保持使用 ACP `session/cancel` |
| 模型切换 | 优先尝试 ACP `session/set_model`；失败时退化为断开并带新模型参数重启 |

### 模型列表降级方案

| 场景 | 处理方式 |
|---|---|
| 连接前 | 不再依赖静态解析 Qwen 安装包来展示模型列表；允许前端先为空，或提供一组可配置的常用模型候选 |
| 连接后 | 以 `session/new` / `session/load` 返回的 `models` 和后续配置更新为准 |
| 无模型元数据 | 允许用户手动输入模型名，连接和切换逻辑不依赖前端先拿到完整列表 |

### 会话恢复策略

| 方案 | 结论 |
|---|---|
| ACP `session/load` | 首选方案，作为主恢复链路 |
| CLI `--continue` / `--resume` | 不作为首阶段主方案；仅在验证发现 Qwen ACP `session/load` 不可用时，作为后备恢复方案重新评估 |

## 错误处理

| 场景 | 处理方式 |
|---|---|
| `qwen` 不存在或不可执行 | 连接命令直接失败，前端提示路径与错误摘要 |
| `qwen --acp` 启动失败 | 标记 Agent 为 `error`，停止后续初始化 |
| `initialize` / `session/new` / `session/load` 超时 | 当前连接失败，前端可重新连接，不做静默无限重试 |
| 运行中子进程退出 | 发出统一错误事件，结束当前 inflight 状态，Agent 进入离线或错误态 |
| 历史会话存在但 ACP 恢复失败 | 历史仍可浏览；用户发送新消息时回退到新会话，并明确提示 |
| Qwen 不支持 `session/set_model` | 自动退化为重启 Agent 切模型 |
| Qwen 不支持 `session/set_think` | 前端展示“不支持思考模式切换”，不伪造成功状态 |

## 持久化兼容策略

| 项目 | 策略 |
|---|---|
| Tauri 存储文件名 | 首阶段保持 `iflow-session-store-<env>.json` 不变，避免升级后本地会话快照丢失 |
| localStorage key | 首阶段保持现有 `iflow-*` key 不变，不做重命名，避免主题、通知、快捷键、草稿、历史等用户设置丢失 |
| 旧 Agent 数据 | 启动时读取已持久化 Agent，若 `type === "iflow"`，归一化为 `qwen`；若存在 `iflowPath` 且 `qwenPath` 为空，则迁移到 `qwenPath` |
| 旧历史来源字面值 | 读取到 `source === "iflow-log"` 时，在内存中归一化为 `qwen-log`；写回时统一使用 `qwen-log` |
| 旧会话快照 | 旧会话继续可读；与 Qwen 当前运行时无法恢复的历史会话仍按只读历史处理，不阻塞新会话流程 |
| 兼容窗口 | 首阶段以“读旧写新、键名不变”为原则；后续若要重命名存储文件或 key，再单独做一次性迁移 |

## 命名策略

| 原则 | 说明 |
|---|---|
| 一次性彻底更换 | 所有 `iflow` 命名，包括文件名、函数名、变量名、类型名、Tauri 命令名，统一改为 `qwen` |
| 不引入双栈 | 不保留 iflow/qwen 双分支逻辑，避免未来再背负兼容包袱 |

## 风险与约束

| 风险 | 说明 | 对策 |
|---|---|---|
| 传输层改动较大 | 现有适配器深度依赖 WebSocket | 已确认 Qwen 使用 NDJSON stdio；实现时抽出“收发消息接口”，尽量复用 ACP 状态机 |
| Qwen 历史结构不同 | 不能直接复用 iFlow JSONL 解析 | 单独实现 Qwen 历史解析，只提取稳定文本字段 |
| 模型列表来源变化 | 无法再沿用 iFlow bundle 解析 | 以 `session/new` / `session/load` 响应和配置更新为主，连接前使用空态或手动输入降级 |
| 部分 ACP 方法可能不同 | `set_model`、`set_think`、terminal 类能力不一定完全兼容 | 保留回退路径，不阻塞主聊天流程 |
| 恢复路径差异 | Qwen CLI 还有 `--continue` / `--resume`，与 ACP `session/load` 语义可能重叠 | 首阶段先验证并固定 `session/load`；若不工作再切换后备方案 |
| 旧持久化数据兼容 | 现有存储文件名、localStorage key、`type/source` 字面值都带有 `iflow` 痕迹 | 首阶段保持键名不变，并在加载时做归一化迁移，避免用户数据丢失 |

## 测试与验收

| 类型 | 验证内容 |
|---|---|
| Rust 单测 | Qwen 历史目录映射、Qwen JSONL 解析、技能目录扫描、错误归一化 |
| 前端单测 | Agent 默认值、历史同步、模型切换退化逻辑、错误提示 |
| 手工验证 | 连接 Qwen、发送消息、停止生成、刷新后重连、加载 Qwen 历史、切换模型、读取技能 |
| 验收标准 | 应用运行时不再依赖 `~/.iflow/*`；默认接入 Qwen；聊天、停止、历史、重连链路可用 |

## 实施顺序

| 顺序 | 任务 |
|---|---|
| 1 | 文件与命令重命名：`iflow_adapter.rs -> qwen_adapter.rs`，以及所有 `iflow` 函数名、类型名、Tauri 命令名统一改为 `qwen` |
| 2 | 删除 WebSocket/端口依赖：`find_available_port()`、`tokio-tungstenite`、`url`、`ConnectResponse.port`、相关前端 `port` 存储 |
| 3 | 后端 ACP 传输层从 WebSocket 改为 stdio，并移除内部重试循环 |
| 4 | 历史读取切到 `~/.qwen/projects/.../chats/*.jsonl`，同步修正文案 fallback 为 `Qwen 会话` |
| 5 | 技能目录切到 `~/.qwen/skills`，删除 `_iflow/*` 私有 request handler |
| 6 | 删除 `model_resolver.rs` 与静态模型列表命令，前端改为动态/手动输入模型策略 |
| 7 | 前端 Tauri 调用、重连语义、默认值与文案切到 Qwen |
| 8 | 补齐测试并验证 |
| 9 | 启动新的开发服务供手工测试 |
