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
| ACP 传输层 | `src-tauri/src/agents/iflow_adapter.rs` 负责 WebSocket 连接与收发 | 替换为 Qwen `stdio ACP` 适配层，尽量复用现有 ACP 会话状态机 |
| 历史读取 | 从 `~/.iflow/projects/.../session-*.jsonl` 读取 | 仅从 `~/.qwen/projects/.../chats/*.jsonl` 读取 |
| 技能发现 | 扫描 `~/.iflow/skills` | 仅扫描 `~/.qwen/skills` |
| 模型列表 | 通过解析 iFlow bundle 静态提取模型列表 | 以 `session/new` / `session/load` 返回的 `models` 字段和后续 ACP 配置更新为主要来源；连接前提供降级方案 |
| 前端文案 | “添加 iFlow Agent”“iFlow CLI 路径”等 | 统一替换为 Qwen 对应文案 |

## 模块级设计

### 1. 后端命令层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` | 将 `spawn_iflow_agent` 改为基于 Qwen 的启动逻辑；不再申请端口；连接命令内部全部切到 Qwen |
| `src-tauri/src/state.rs` | `AgentInstance` 中的 `iflow_path` 改为更中性的 `cli_path`；`port` 对 Qwen 不再作为必需字段 |
| `src-tauri/src/models.rs` | `AgentInfo.agent_type` 固定为 `qwen`；必要时保留现有结构以减少前端改动 |

### 2. ACP 适配层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agents/iflow_adapter.rs` | 替换为 Qwen `stdio ACP` 适配实现，保留当前 ACP 状态机和事件分发语义 |
| `src-tauri/src/agents/session_params.rs` | 继续复用，前提是 Qwen ACP 的请求结构与当前使用方式兼容 |
| `src-tauri/src/router.rs` | 尽量不改业务路由，只在必要时适配 Qwen 返回的 payload 差异 |

### 2.1 stdio 传输实现

| 项目 | 设计 |
|---|---|
| 子进程启动 | 使用 `tokio::process::Command` 启动 `qwen --acp`，并显式获取 `stdin`、`stdout`、`stderr` |
| 消息发送 | 通过子进程 `stdin` 写入 ACP JSON-RPC 消息，使用逐条写入并在每条消息后 flush |
| 消息接收 | 通过 `tokio::io::BufReader` 包装 `stdout`，按行读取 ACP JSON 消息 |
| stderr 处理 | `stderr` 不参与 ACP 协议，仅作为日志流异步消费，避免缓冲区阻塞导致子进程挂起 |
| 子进程退出 | 增加独立 wait 任务监听退出码；一旦退出，统一向前端发错误事件并清理 inflight 状态 |
| 连接关闭 | 当 `stdout` EOF、`stdin` 写失败或 wait 任务先结束时，都视为 ACP 连接断开 |

### 3. 历史会话层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/history.rs` | 移除 iFlow 目录推导和数据结构假设，改为基于 `~/.qwen/projects/<workspace-key>/chats/*.jsonl` 的解析 |
| 历史内容提取 | 按 Qwen `message.parts` 数组解析，仅提取有 `text` 的条目；忽略 `functionCall` 等无法稳定映射的结构化条目 |
| 历史会话名 | 优先使用首条用户消息压缩为标题，不追求还原所有系统事件 |
| Session ID 归一化 | 直接使用文件名去掉 `.jsonl` 后的 UUID，不再校验 `session-` 前缀 |

### 3.1 Qwen 历史文件结构

| 字段 | 说明 |
|---|---|
| 顶层 `type` | 使用 `user` / `assistant` 作为主要可展示消息类型 |
| 顶层 `sessionId` | 与 JSONL 文件名一致，可用于历史会话加载 |
| `message.parts` | 为数组结构，不再假设存在 iFlow 样式的 `message.content` |
| `parts[].text` | 作为主文本来源 |
| `parts[].thought` | 若存在且为 `true`，表示思考内容；首阶段历史面板默认不单独展示 |
| `parts[].functionCall` | 视为结构化工具信息，首阶段忽略，不写入普通聊天消息 |

### 3.2 Project Key 规则

| 项目 | 规则 |
|---|---|
| 基本规则 | 将 workspace 绝对路径中的 `/`、`:` 替换为 `-` |
| 前缀规则 | 若转换后不以 `-` 开头，再补一个前导 `-` |
| 当前工作区示例 | `/Users/chenweilong/www/FlowHub` -> `-Users-chenweilong-www-FlowHub` |

### 4. 技能发现层

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` 中技能扫描逻辑 | 根目录从 `~/.iflow/skills` 切换为 `~/.qwen/skills` |
| 前端 `discoverSkills` 结果 | `agentType` 改为 `qwen`，其余结构保持兼容 |

### 5. 前端表现层

| 文件 | 改动 |
|---|---|
| `index.html` | 弹窗标题、占位符、默认 Agent 名称、CLI 路径说明统一改为 Qwen |
| `src/features/agents/actions.ts` | 新增 Agent 时默认 `agent.type = "qwen"`，ID 前缀、成功提示、加载提示同步切换 |
| `src/services/tauri.ts` | 优先对外提供 Qwen 语义的包装；为降低改动量，可短期保留旧函数名作为内部兼容层 |
| `src/types.ts` | `source`、类型注释和字面值逐步从 `iflow` 迁移到 `qwen` |
| 默认 CLI 路径 | 添加 Agent 弹窗中的默认占位提示从 `iflow` 改为 `qwen` |

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

## 命名策略

| 原则 | 说明 |
|---|---|
| 先改行为 | 第一阶段优先完成 Qwen 接入和历史切换 |
| 再改内部命名 | 对外文案与关键类型值立即改为 `qwen`；内部少量 `iflow` 函数名可以先保留一层兼容，避免一次性大重命名 |
| 不引入双栈 | 不保留 iflow/qwen 双分支逻辑，避免未来再背负兼容包袱 |

## 风险与约束

| 风险 | 说明 | 对策 |
|---|---|---|
| 传输层改动较大 | 现有适配器深度依赖 WebSocket | 抽出“收发消息接口”，尽量复用 ACP 状态机 |
| Qwen 历史结构不同 | 不能直接复用 iFlow JSONL 解析 | 单独实现 Qwen 历史解析，只提取稳定文本字段 |
| 模型列表来源变化 | 无法再沿用 iFlow bundle 解析 | 以 `session/new` / `session/load` 响应和配置更新为主，连接前使用空态或手动输入降级 |
| 部分 ACP 方法可能不同 | `set_model`、`set_think` 等可选能力不一定完全兼容 | 保留回退路径，不阻塞主聊天流程 |

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
| 1 | 后端 ACP 传输层从 WebSocket 改为 stdio |
| 2 | 历史读取切到 `~/.qwen/projects/.../chats/*.jsonl` |
| 3 | 技能目录切到 `~/.qwen/skills` |
| 4 | 前端默认值与文案切到 Qwen |
| 5 | 补齐测试并验证 |
| 6 | 启动新的开发服务供手工测试 |
