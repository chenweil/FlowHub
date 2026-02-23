# FlowHub

基于 Tauri 的多 Agent 桌面工作台 MVP，当前重点是 iFlow ACP 协议接入与对话可视化。

## 当前状态

- 已完成 iFlow ACP 基础连接（WebSocket + JSON-RPC 会话）
- 已支持消息发送、流式回复展示、工具调用展示、任务结束状态
- 已支持 Agent 管理（新增、选择、删除、重连）与本地持久化（Agent 列表）
- MVP 阶段，优先验证协议链路与交互闭环

## 技术栈

- Frontend: TypeScript + Vite
- Desktop: Tauri 2.0
- Backend: Rust (Tokio, tokio-tungstenite)

## 目录结构

```text
iflow-workspace/
├── src/                 # 前端 TS 入口与样式
├── src-tauri/           # Rust 后端与 Tauri 配置
├── DEVELOPMENT_PLAN.md  # 需求与开发计划
└── package.json         # 前端与 Tauri 脚本
```

## 本地开发

### 前提安装

- 先安装 iFlow CLI：`https://cli.iflow.cn/`
- 确保终端可直接执行 `iflow --help`

### 1) 安装依赖

```bash
npm install
```

### 2) 启动前端（仅 UI）

```bash
npm run dev
```

默认地址：`http://localhost:1420`

### 3) 启动完整桌面应用（推荐）

```bash
npm run tauri:dev
```

## 构建

```bash
npm run build
npm run tauri:build
```

## 测试与检查

```bash
cd src-tauri
cargo check
cargo test
```

## MVP 已知边界

- 目前主要适配 iFlow，其他 Agent 类型尚未接入
- 会话历史持久化与多标签会话仍在后续计划中
- 工具调用展示已可用，但仍有可视化优化空间

## 规划参考

详细规划见：`DEVELOPMENT_PLAN.md`
