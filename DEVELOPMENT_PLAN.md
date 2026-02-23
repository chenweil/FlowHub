# ACP GUI 客户端 - 开发需求与计划

## 项目概述

基于 ACP (Agent Communication Protocol) 的 GUI 客户端，用于连接和管理多个 AI Agent，提供可视化的对话界面和工具调用展示。

**技术栈**: Tauri (Rust) + TypeScript + Vite

---

## 已完成的工作 ✅

### 1. 项目调研
- [x] 分析了 OpenWork、Mossx、Codexia 等参考项目
- [x] 研究了 ACP 协议规范和通信机制
- [x] 确定了多 Agent 架构的可行性

### 2. 技术选型
- [x] 选择了 Tauri + TypeScript + Vite 架构
- [x] 确定了 WebSocket 作为 ACP 通信协议
- [x] 选择了轻量级前端方案（原生 TS，无框架）

### 3. 项目初始化
- [x] 创建了 Tauri 项目框架
- [x] 配置了开发环境（Rust、Node.js）
- [x] 设置了项目结构和构建流程

### 4. ACP 协议模块
- [x] 实现了 WebSocket 连接管理 (`AcpConnection`)
- [x] 实现了消息序列化和反序列化
- [x] 支持的消息类型：
  - `user_message` - 用户消息
  - `agent_message_chunk` - Agent 流式响应
  - `agent_thought_chunk` - Agent 思考过程
  - `tool_call` / `tool_call_update` - 工具调用
  - `plan` - 执行计划
  - `stop_reason` / `task_finish` - 任务完成

### 5. 基础 UI 实现
- [x] 创建了对话界面布局
- [x] 实现了 Agent 列表侧边栏
- [x] 实现了消息展示区域（支持流式输出）
- [x] 实现了输入框和发送功能
- [x] 添加了工具调用面板
- [x] 实现了添加 Agent 的弹窗

### 6. Rust 后端功能
- [x] `connect_iflow` - 连接 iFlow Agent
- [x] `send_message` - 发送消息并启动后台监听
- [x] `stop_receiving` - 停止接收消息
- [x] `get_messages` - 获取消息历史
- [x] `disconnect_agent` - 断开 Agent 连接
- [x] 实现了端口自动分配（查找可用端口）
- [x] 实现了进程管理和清理

### 7. 前端功能
- [x] Agent 的添加、删除、选择
- [x] 消息的实时流式显示
- [x] 工具调用的展示
- [x] 本地存储（Agent 列表持久化）
- [x] 连接状态管理

### 8. 环境修复
- [x] 解决了 Rust 版本兼容性问题
- [x] 修复了编译错误
- [x] 添加了必要的图标文件
- [x] 配置了 Tauri 2.0 环境

---

## 剩余计划 📋

### Phase 1: 核心功能增强

#### 1.1 多 Agent 支持 🔥
**优先级**: 高
**描述**: 目前只支持 iFlow，需要扩展到其他 Agent

**任务列表**:
- [ ] 设计统一的 Agent 接口抽象
- [ ] 支持 Claude Code 集成
  - [ ] 研究 Claude Code 的 MCP/ACP 协议
  - [ ] 实现 `connect_claude` 命令
  - [ ] 适配 Claude 的消息格式
- [ ] 支持 Codex (OpenAI) 集成
  - [ ] 研究 Codex CLI 的通信协议
  - [ ] 实现 `connect_codex` 命令
- [ ] 支持自定义 Agent 配置
- [ ] 添加 Agent 类型图标区分

**技术要点**:
```rust
// 设计统一的 Agent trait
pub trait Agent {
    async fn connect(&mut self) -> Result<(), String>;
    async fn send(&mut self, message: String) -> Result<(), String>;
    async fn receive(&mut self) -> Result<String, String>;
    async fn disconnect(&mut self) -> Result<(), String>;
}
```

#### 1.2 多会话标签页 🔥
**优先级**: 高
**描述**: 支持多个并行的对话会话

**任务列表**:
- [ ] 设计会话数据模型
- [ ] 实现标签页 UI 组件
- [ ] 实现会话的创建、切换、关闭
- [ ] 会话状态管理（每个会话独立的消息历史）
- [ ] 会话持久化到本地存储
- [ ] 会话重命名功能

**UI 设计**:
```
┌─────────────────────────────────────┐
│ 会话 1 │ 会话 2 │ 会话 3 │ +        │
├─────────────────────────────────────┤
│                                     │
│   对话内容区域                       │
│                                     │
└─────────────────────────────────────┘
```

#### 1.3 工具调用可视化增强
**优先级**: 中
**描述**: 更好的 Tool Call 展示和交互

**任务列表**:
- [ ] 设计工具调用卡片组件
- [ ] 支持工具调用的展开/折叠
- [ ] 显示工具调用的执行时间
- [ ] 支持工具参数的格式化展示（JSON 高亮）
- [ ] 支持工具执行结果的格式化展示
- [ ] 添加工具调用历史记录
- [ ] 支持重新执行工具调用

**UI 改进**:
- 使用树形结构展示嵌套工具调用
- 添加工具图标和颜色标识
- 支持代码高亮显示参数和结果

### Phase 2: 文件与历史管理

#### 2.1 文件浏览器集成
**优先级**: 中
**描述**: 集成文件系统浏览功能

**任务列表**:
- [ ] 添加 Tauri FS 插件权限
- [ ] 实现文件树组件
- [ ] 支持文件/文件夹的浏览
- [ ] 支持文件内容预览（文本、图片）
- [ ] 实现文件拖拽上传
- [ ] 支持在对话中引用文件
- [ ] 实现文件搜索功能

**功能细节**:
```typescript
interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  modified?: Date;
}
```

#### 2.2 会话历史持久化 🔥
**优先级**: 高
**描述**: 保存和加载历史会话

**任务列表**:
- [ ] 设计会话存储格式
- [ ] 实现 SQLite 或文件系统存储
- [ ] 自动保存会话历史
- [ ] 实现历史会话列表
- [ ] 支持搜索历史会话
- [ ] 支持导出会话为 Markdown/JSON
- [ ] 支持导入会话
- [ ] 实现会话归档功能

**存储设计**:
```typescript
interface Session {
  id: string;
  title: string;
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
  metadata: {
    totalTokens?: number;
    toolCallCount?: number;
  };
}
```

### Phase 3: 高级功能

#### 3.1 Git 工作流集成
**优先级**: 中
**描述**: 类似 Commander AI 的 Git 集成功能

**任务列表**:
- [ ] 集成 Git 状态检测
- [ ] 显示当前分支和修改文件
- [ ] 支持生成 Commit Message
- [ ] 支持查看 Diff
- [ ] 实现一键提交功能
- [ ] 支持创建分支
- [ ] 集成 PR/MR 创建

**UI 组件**:
- Git 状态面板（显示分支、修改文件数）
- Diff 查看器
- Commit 对话框

#### 3.2 技能系统
**优先级**: 低
**描述**: 保存和复用常用工作流

**任务列表**:
- [ ] 设计技能数据模型
- [ ] 实现技能创建界面
- [ ] 支持参数化技能模板
- [ ] 实现技能库管理
- [ ] 支持技能分享/导入
- [ ] 实现快捷命令（如 `/refactor`, `/test`）

**技能示例**:
```yaml
skill:
  name: "代码重构"
  description: "分析并重构选中的代码"
  prompt: "请重构以下代码，提高可读性和性能：\n\n{{code}}"
  parameters:
    - name: code
      type: string
      required: true
```

### Phase 4: 优化与扩展

#### 4.1 性能优化
- [ ] 实现虚拟滚动（处理长对话）
- [ ] 优化消息渲染性能
- [ ] 实现增量保存
- [ ] 优化内存使用

#### 4.2 设置与配置
- [ ] 实现设置面板
- [ ] 支持主题切换（深色/浅色）
- [ ] 支持快捷键配置
- [ ] 支持代理设置
- [ ] 支持日志级别配置

#### 4.3 打包与发布
- [ ] 配置应用签名
- [ ] 实现自动更新
- [ ] 创建安装程序
- [ ] 编写用户文档

---

## 技术债务 🔧

1. **错误处理**: 需要统一错误处理机制，提供更好的用户反馈
2. **状态管理**: 当前状态管理较分散，考虑引入状态管理库
3. **类型安全**: 前后端类型定义需要同步，考虑使用生成工具
4. **测试覆盖**: 需要添加单元测试和集成测试
5. **日志系统**: 需要完善的日志记录和查看功能

---

## 当前架构

### 后端 (Rust)
```
src-tauri/src/
└── main.rs
    ├── AcpConnection      # WebSocket 连接管理
    ├── AgentInstance      # Agent 实例管理
    ├── AppState           # 全局状态
    ├── Commands           # Tauri 命令
    │   ├── connect_iflow
    │   ├── send_message
    │   ├── stop_receiving
    │   ├── get_messages
    │   └── disconnect_agent
    └── Types
        ├── AgentInfo
        ├── Message
        └── ToolCall
```

### 前端 (TypeScript)
```
src/
├── main.ts              # 主入口，事件处理
└── styles.css           # 样式

index.html               # 主页面
```

### 数据流
```
用户输入 → UI → Tauri Command → Rust 后端 → WebSocket → iFlow
                                           ↓
流式响应 ← UI ← Tauri Event ← Rust 后端 ← WebSocket
```

---

## 下一步行动 🔜

根据优先级，建议按以下顺序进行：

1. **立即开始**: 多会话标签页（高优先级，提升用户体验）
2. **本周内**: 会话历史持久化（高优先级，数据安全）
3. **下周**: 多 Agent 支持（扩展性）
4. **后续**: 工具调用可视化、文件浏览器、Git 集成等

---

## 参考资源

- [ACP Protocol Specification](https://github.com/...)
- [Tauri Documentation](https://tauri.app/)
- [OpenWork](https://github.com/...)
- [Mossx](https://github.com/...)
- [Codexia](https://github.com/...)

---

*最后更新: 2026-02-24*
