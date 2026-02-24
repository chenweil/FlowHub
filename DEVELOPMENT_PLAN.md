# ACP GUI 客户端 - 开发需求与计划（v2）

## 项目概述

基于 ACP (Agent Communication Protocol) 的 GUI 客户端，用于连接和管理多个 AI Agent，提供可视化对话界面、工具调用展示与会话管理能力。

**技术栈**: Tauri (Rust) + TypeScript + Vite

---

## 当前状态（2026-02-24）

### 已实现能力

| 领域 | 状态 | 说明 |
| --- | --- | --- |
| iFlow ACP 链路 | 已完成 | WebSocket + JSON-RPC 会话建立、消息发送、流式回复、任务结束事件 |
| Agent 管理 | 已完成 | 新增/选择/删除/重连 Agent，进程生命周期管理 |
| 会话能力 | 部分完成 | 支持多会话创建、切换、删除；会话标题自动生成 |
| 会话持久化 | 部分完成 | 后端文件存储（app data）+ localStorage 回退与迁移 |
| 工具调用展示 | 已完成 | tool_call / tool_call_update 可视化展示 |
| 命令/MCP 注册 | 已完成 | 解析并展示可用命令与 MCP server 列表 |

### 当前命令面（Tauri）

| 命令 | 作用 | 当前状态 |
| --- | --- | --- |
| `connect_iflow` | 启动并连接 iFlow ACP 会话 | 已使用 |
| `send_message` | 向当前 Agent 会话发送消息 | 已使用 |
| `disconnect_agent` | 断开并清理 Agent | 已使用 |
| `load_storage_snapshot` | 读取会话/消息快照 | 已使用 |
| `save_storage_snapshot` | 保存会话/消息快照 | 已使用 |

### 当前架构（真实结构）

#### 后端（Rust / Tauri）

```text
src-tauri/src/
├── main.rs
├── commands.rs
├── manager.rs
├── models.rs
├── router.rs
├── state.rs
├── storage.rs
└── agents/
    ├── iflow_adapter.rs
    └── mod.rs
```

#### 前端（TypeScript）

```text
src/
├── main.ts
└── styles.css

index.html
```

### 数据流

```text
用户输入 -> UI -> Tauri Command -> Rust 后端 -> WebSocket -> iFlow
                                       ↓
流式响应 <- UI <- Tauri Event   <- Rust 后端 <- WebSocket
```

---

## 当前迭代计划（唯一执行入口）

### 迭代策略（参考 CodexMonitor）

| 项目 | 结论 | 落地策略 |
| --- | --- | --- |
| 许可证 | 可复用（MIT） | 保留原版权和许可证声明 |
| 是否全量 Fork 改造 | 不建议 | 避免大规模协议/架构重写风险 |
| 推荐方案 | 模块借鉴 + 渐进迁移 | 保持 iFlow 主链路稳定，分阶段演进 |

### 两周路线图

| 周次 | 目标 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| 第 1 周 | 稳定内核，降低耦合 | 1) ACP 后端拆分<br>2) 前端 IPC/事件层抽离<br>3) 会话状态集中 | 连接、发送、流式、tool-call、task-finish 无回归 |
| 第 2 周 | 补齐工程化能力 | 1) workspace 抽象<br>2) 重连/错误恢复强化<br>3) 测试补全 | `cargo check` 与 `cargo test` 通过，核心手工回归通过 |

### 本周执行清单（P0/P1）

| 优先级 | 任务 | 文件范围 | 状态 |
| --- | --- | --- | --- |
| P0 | 拆分 `iflow_adapter`（等价重构） | `src-tauri/src/agents/iflow_adapter.rs` | 待开始 |
| P0 | 抽离 Tauri IPC 服务层 | `src/services/tauri.ts`（新增） | 待开始 |
| P0 | 抽离事件总线层 | `src/services/events.ts`（新增） | 待开始 |
| P0 | 主入口瘦身（编排化） | `src/main.ts` | 待开始 |
| P1 | 会话状态 reducer 化 | `src/features/threads/`（新增） | 待开始 |
| P1 | workspace 领域抽象 | Rust + TS 对应模块 | 待开始 |

---

## 重点能力进度（部分完成项）

### 1.2 多会话（原“多会话标签页”）

| 子项 | 状态 | 说明 |
| --- | --- | --- |
| 会话数据模型 | 已完成 | 已有 `Session` 结构与按 Agent 分组模型 |
| 会话创建/切换/删除 | 已完成 | 已支持新建、切换、删除与默认会话兜底 |
| 会话独立消息历史 | 已完成 | `messagesBySession` 独立维护 |
| 会话持久化 | 已完成 | 已接入后端快照 + localStorage 回退 |
| 标签页式 UI | 未完成 | 当前为侧栏会话列表，不是顶部 tab |
| 会话重命名 | 未完成 | 仍待实现 |

### 2.2 会话历史持久化

| 子项 | 状态 | 说明 |
| --- | --- | --- |
| 存储格式设计 | 已完成 | 已有 `StorageSnapshot`、`StoredSession`、`StoredMessage` |
| 文件存储 | 已完成 | `storage.rs` 写入 app data，按环境分文件 |
| 自动保存 | 已完成 | 会话和消息变更后会持久化 |
| 历史会话展示 | 已完成 | 侧栏可展示会话历史 |
| localStorage 兼容迁移 | 已完成 | 后端不可用时回退并支持 legacy 迁移 |
| 历史搜索 | 未完成 | 待实现 |
| 导入/导出 | 未完成 | 待实现 |
| 会话归档 | 未完成 | 待实现 |

---

## 中长期 Backlog（待排期）

| 阶段 | 方向 | 主要内容 |
| --- | --- | --- |
| Phase A | 多 Agent 扩展 | Claude/Codex 接入、统一 Agent 抽象、自定义 Agent 配置 |
| Phase B | 文件能力 | 文件树、预览、搜索、对话引用 |
| Phase C | 工具调用体验 | 工具卡片、参数高亮、历史与重放 |
| Phase D | Git 工作流 | 状态、diff、commit、分支与 PR 辅助 |
| Phase E | 体验优化 | 虚拟滚动、性能优化、设置面板、打包发布 |

---

## 技术债务与风险

| 项目 | 当前情况 | 处理方向 |
| --- | --- | --- |
| 模块耦合 | `main.ts` 和 `iflow_adapter.rs` 体量偏大 | 按职责拆层，降低耦合 |
| 状态分散 | 前端状态分布在多个 map 与函数 | reducer 化并按功能域拆分 |
| 类型契约 | 前后端类型同步靠手工维护 | 增加契约校验与集中定义 |
| 测试覆盖 | 关键路径有测试但不完整 | 补充核心流程与回归测试 |
| 错误可观测性 | 仍以控制台日志为主 | 统一错误分类与提示链路 |

---

## 参考资源

- ACP Protocol Specification
- Tauri Documentation
- CodexMonitor
- OpenWork
- Mossx
- Codexia

---

*最后更新: 2026-02-24*
