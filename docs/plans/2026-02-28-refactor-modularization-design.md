# 模块化重构设计文档

**日期**：2026-02-28
**版本**：v1.0
**背景**：当前 `main.ts`（4421 行）和 `iflow_adapter.rs`（1141 行）+ `commands.rs`（1260 行）体量过大，职责混杂，拖慢后续功能开发。本文档描述等价重构方案，不改变任何对外行为。

---

## 一、目标

| 指标 | 当前 | 目标 |
|------|------|------|
| `main.ts` 行数 | 4421 | ~100（只做初始化编排） |
| `iflow_adapter.rs` 行数 | 1141 | ~400（只保留 WebSocket/ACP 协议层） |
| `commands.rs` 行数 | 1260 | ~200（只做参数校验 + 调用下层） |
| 前端模块数 | 1 | ~15 个单职责模块 |
| 后端 agents/ 模块数 | 1 | 3（adapter + session + history） |

---

## 二、前端目标结构

```
src/
├── main.ts                   # 只做 init + 模块编排（目标 ~100 行）
│
├── services/
│   ├── tauri.ts              # 所有 invoke() 调用的类型化封装
│   └── events.ts             # 所有 listen() 订阅，对外 emit 内部事件
│
├── features/
│   ├── agents/
│   │   ├── state.ts          # agentList、currentAgentId、Agent 状态
│   │   └── actions.ts        # connect、disconnect、rename、loadAgents
│   ├── sessions/
│   │   ├── state.ts          # sessionList、currentSessionId、messagesBySession
│   │   └── actions.ts        # create、select、delete、rename、title 生成
│   ├── ui/
│   │   ├── chat.ts           # 消息渲染、appendStreamMessage、renderMessages
│   │   ├── sidebar.ts        # Agent 列表 + 会话列表渲染
│   │   ├── composer.ts       # 输入区、发送按钮、slash 命令菜单
│   │   └── modals.ts         # 弹窗（artifact 预览、重命名、确认框）
│   └── storage/
│       └── index.ts          # loadStorageSnapshot / saveStorageSnapshot / 迁移
│
└── lib/
    ├── markdown.ts           # Markdown 渲染（renderMarkdownContent + 工具函数）
    ├── html.ts               # escapeHtml、sanitizeMarkdownUrl
    └── utils.ts              # formatTime、shortId、generateAcpSessionId 等
```

### 层间职责约束

| 层 | 职责 | 禁止 |
|----|------|------|
| `services/` | Tauri IPC 通信 | 不含业务逻辑 |
| `features/` | 状态管理 + 业务操作 | 不直接操作其他 feature 的状态 |
| `lib/` | 纯函数工具 | 无副作用、无状态 |
| `main.ts` | 初始化编排 | 不含业务逻辑 |

---

## 三、后端目标结构

```
src-tauri/src/
├── main.rs                   # 不变（Tauri setup）
├── state.rs                  # 不变（AppState）
├── models.rs                 # 不变（数据结构）
├── storage.rs                # 不变（文件存储）
├── manager.rs                # 不变（Agent 生命周期）
├── router.rs                 # 不变（事件路由）
│
├── commands.rs               # 瘦身：只做参数校验 + 调用下层
│
└── agents/
    ├── mod.rs                # 对外暴露统一接口
    ├── iflow_adapter.rs      # 只保留 WebSocket 连接 + ACP 协议收发
    ├── session.rs            # session/new、load、cancel、set_model 业务逻辑
    └── history.rs            # iFlow .jsonl 历史文件读取与解析
```

### 后端模块职责边界

| 代码 | 现在位置 | 目标位置 |
|------|---------|---------|
| WebSocket 连接建立/断开 | `iflow_adapter.rs` | 保留 `iflow_adapter.rs` |
| ACP JSON-RPC 消息收发 | `iflow_adapter.rs` | 保留 `iflow_adapter.rs` |
| session/new、load、cancel | `iflow_adapter.rs` | → `session.rs` |
| iFlow .jsonl 历史读取 | `commands.rs` | → `history.rs` |
| Tauri 命令入口 | `commands.rs` | 保留但瘦身 |

---

## 四、执行顺序

**原则**：每步独立可验证，主链路不中断，每阶段独立 commit。

### 阶段 1：后端拆分

| 步骤 | 操作 | 验收 |
|------|------|------|
| 1a | 从 `iflow_adapter.rs` 抽出 `history.rs` | `cargo check` 通过 |
| 1b | 从 `iflow_adapter.rs` 抽出 `session.rs` | `cargo check` 通过 |
| 1c | `commands.rs` 瘦身，调用 `session.rs` / `history.rs` | ACP 链路手工验证 |

### 阶段 2：前端 lib 层抽离（纯函数，零风险）

| 步骤 | 操作 | 验收 |
|------|------|------|
| 2a | 抽出 `lib/markdown.ts` | Markdown/表格/代码块渲染正常 |
| 2b | 抽出 `lib/html.ts` + `lib/utils.ts` | 页面渲染无变化 |

### 阶段 3：前端 services 层抽离

| 步骤 | 操作 | 验收 |
|------|------|------|
| 3a | 抽出 `services/tauri.ts` | 连接/发送/流式无回归 |
| 3b | 抽出 `services/events.ts` | tool-call / task-finish 事件正常 |

### 阶段 4：前端 features 层抽离

| 步骤 | 操作 | 验收 |
|------|------|------|
| 4a | 抽出 `features/storage/index.ts` | 历史加载/保存正常 |
| 4b | 抽出 `features/sessions/` | 多会话切换/创建/删除正常 |
| 4c | 抽出 `features/agents/` | Agent 管理/重连正常 |
| 4d | 抽出 `features/ui/` | 全页面渲染无回归 |

### 阶段 5：main.ts 瘦身收尾

| 步骤 | 操作 | 验收 |
|------|------|------|
| 5a | 主入口精简为 init 编排 | 全功能手工回归通过 |

---

## 五、验收基准（全阶段通用）

每阶段完成后，以下链路必须手工验证通过：

1. Agent 连接（`connect_iflow`）
2. 消息发送与流式回复
3. tool_call / tool_call_update 展示
4. task-finish 事件处理
5. 多会话切换与历史加载
6. iFlow 历史导入

Rust 侧额外要求：`cargo check` 与 `cargo test` 通过。

---

## 六、不在本次范围内

- 新增功能
- 修改 ACP 协议行为
- 修改 UI 交互逻辑
- Phase A-E backlog 中的任何功能
