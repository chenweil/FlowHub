# 模块化重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `main.ts`（4421 行）和 `iflow_adapter.rs`（1141 行）/ `commands.rs`（1260 行）按职责拆分为多个单职责模块，不改变任何对外行为。

**Architecture:** 后端先拆（风险最低），前端从 lib → services → features 渐进抽离。每阶段独立 commit + 验证，主链路随时可运行。

**Tech Stack:** Rust (Tauri 2.0), TypeScript (ES Modules, Vite), cargo check, tsc --noEmit

---

## 验收基准（每阶段结束后必须验证）

每完成一个 Task 提交前，运行以下检查：

**Rust 侧：**
```bash
cd src-tauri && cargo check 2>&1 | tail -5
```
期望：`warning: ...` 可以有，但无 `error:`

**TypeScript 侧：**
```bash
npx tsc --noEmit 2>&1 | tail -10
```
期望：无错误输出

**手工链路（最终验收）：**
1. `npm run tauri:dev` 启动
2. 连接 Agent → 发送消息 → 流式回复正常
3. 工具调用面板显示
4. 多会话切换正常
5. iFlow 历史会话列表加载正常

---

## 阶段 1：后端拆分

### Task 1：提取 `history.rs`（从 `commands.rs` 移出历史相关函数）

**Files:**
- Create: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**背景：** `commands.rs` 中 419–924 行是 iFlow `.jsonl` 历史文件的读写逻辑，与 Tauri 命令层完全解耦，适合首先提取。

**Step 1: 新建 `src-tauri/src/history.rs`**

创建文件，头部写入：
```rust
//! iFlow 历史会话文件读取与解析
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
```

然后从 `commands.rs` 中将以下函数**剪切**到 `history.rs`（保持函数签名不变）：

| 函数名 | commands.rs 起始行 |
|--------|-------------------|
| `normalize_workspace_path` | 419 |
| `workspace_to_iflow_project_key` | 427 |
| `iflow_projects_root` | 436 |
| `iflow_project_dirs_for_workspace` | 441 |
| `to_rfc3339_or_now` | 458 |
| `compact_title` | 465 |
| `extract_text_value` | 477 |
| `extract_text_entries_only` | 505 |
| `has_structured_tool_entries` | 555 |
| `extract_history_message_content` | 569 |
| `extract_history_timestamp` | 591 |
| `extract_history_record_cwd` | 599 |
| `parse_iflow_history_summary` | 606 |
| `parse_iflow_history_messages` | 681 |
| `normalize_iflow_session_id` | 844 |

将以下 `pub` 函数也移入，并保持 `pub` 可见性：

| pub 函数名 | commands.rs 起始行 |
|------------|-------------------|
| `list_iflow_history_sessions` | 754 |
| `load_iflow_history_messages` | 807 |
| `delete_iflow_history_session` | 856 |
| `clear_iflow_history_sessions` | 882 |

> 注意：`parse_iflow_history_summary` / `parse_iflow_history_messages` 是 `async` 函数，需要引入 `tokio::fs`。
> `list_iflow_history_sessions` 等需要 `tauri::AppHandle`，保留 `pub` 且补齐 imports。

**Step 2: 在 `history.rs` 顶部补全 imports**

```rust
use tokio::fs;
use tauri::AppHandle;
// 根据实际使用补充，cargo check 会提示缺失的 use
```

**Step 3: 在 `commands.rs` 顶部添加对 history 模块的引用**

在 `commands.rs` 顶部 use 区域添加：
```rust
use crate::history::{
    list_iflow_history_sessions, load_iflow_history_messages,
    delete_iflow_history_session, clear_iflow_history_sessions,
};
```

**Step 4: 在 `main.rs` 注册模块**

```rust
mod history;
```

**Step 5: 验证编译**
```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```
期望：无输出（无 error）

**Step 6: Commit**
```bash
git add src-tauri/src/history.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "refactor(backend): extract history.rs from commands.rs"
```

---

### Task 2：提取 `artifact.rs`（从 `commands.rs` 移出 HTML artifact 函数）

**Files:**
- Create: `src-tauri/src/artifact.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**背景：** `commands.rs` 926–1140 行是 HTML artifact 路径解析与读取逻辑，独立性强。

**Step 1: 新建 `src-tauri/src/artifact.rs`**

从 `commands.rs` **剪切**以下函数到 `artifact.rs`：

| 函数名 | commands.rs 起始行 | 可见性 |
|--------|-------------------|--------|
| `resolve_html_artifact_path_in_workspace` | 926 | private |
| `is_windows_absolute_like` | 974 | private |
| `trim_artifact_path_wrappers` | 984 | private |
| `strip_json_like_artifact_prefix` | 1023 | private |
| `normalize_artifact_request_path` | 1038 | private |
| `validate_html_artifact_file` | 1058 | private |
| `resolve_html_artifact_path` | 1080 | pub |
| `read_html_artifact` | 1098 | pub |

`artifact.rs` 文件头：
```rust
//! HTML Artifact 路径解析与安全读取
use std::path::{Path, PathBuf};
use tauri::State;
use crate::state::AppState;

const MAX_HTML_ARTIFACT_SIZE: u64 = 2 * 1024 * 1024;
```

> 将 `commands.rs` 顶部的 `const MAX_HTML_ARTIFACT_SIZE` 一并移走。

**Step 2: 更新 `commands.rs` 的 use**
```rust
use crate::artifact::{resolve_html_artifact_path, read_html_artifact};
```

**Step 3: 注册模块**

`main.rs` 添加：
```rust
mod artifact;
```

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

**Step 5: Commit**
```bash
git add src-tauri/src/artifact.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "refactor(backend): extract artifact.rs from commands.rs"
```

---

### Task 3：提取 `model_resolver.rs`（iFlow 可执行文件与模型解析）

**Files:**
- Create: `src-tauri/src/model_resolver.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**背景：** `commands.rs` 221–418 行是 iFlow 可执行文件路径解析和模型列表提取，与 Agent 连接逻辑解耦。

**Step 1: 新建 `src-tauri/src/model_resolver.rs`**

从 `commands.rs` **剪切**以下函数：

| 函数名 | commands.rs 起始行 | 可见性 |
|--------|-------------------|--------|
| `resolve_iflow_executable_path` | 221 | private |
| `resolve_iflow_bundle_entry` | 249 | private |
| `push_candidate` | 274 | private |
| `build_bundle_entry_candidates` | 280 | private |
| `extract_bracket_block` | 293 | private |
| `parse_model_entries_from_array_block` | 337 | private |
| `extract_model_options_from_bundle` | 367 | private |
| `list_available_models` | 395 | pub |

文件头：
```rust
//! iFlow 可执行文件路径解析与模型列表提取
use std::path::{Path, PathBuf};
use crate::models::ModelOption;
```

**Step 2: 更新 `commands.rs`**

删除对应函数，顶部添加：
```rust
use crate::model_resolver::{list_available_models, resolve_iflow_executable_path};
```
> `spawn_iflow_agent` 内调用了 `resolve_iflow_executable_path`（或类似函数），需要引入。

**Step 3: 注册模块**

`main.rs` 添加：
```rust
mod model_resolver;
```

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

**Step 5: Commit**
```bash
git add src-tauri/src/model_resolver.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "refactor(backend): extract model_resolver.rs from commands.rs"
```

---

### Task 4：提取 `session_params.rs`（ACP session 参数构建函数）

**Files:**
- Create: `src-tauri/src/agents/session_params.rs`
- Modify: `src-tauri/src/agents/iflow_adapter.rs`
- Modify: `src-tauri/src/agents/mod.rs`

**背景：** `iflow_adapter.rs` 中 211–264 行是 ACP session 参数构建的纯函数，无副作用，最容易提取。

**Step 1: 新建 `src-tauri/src/agents/session_params.rs`**

从 `iflow_adapter.rs` **剪切**以下函数：

| 函数名 | 起始行 |
|--------|--------|
| `build_initialize_params` | 211 |
| `build_session_new_params` | 224 |
| `build_session_new_params_with_id` | 234 |
| `build_session_load_params` | 245 |
| `build_prompt_params` | 256 |

文件头：
```rust
//! ACP JSON-RPC session 请求参数构建
use serde_json::{json, Value};
```

**Step 2: 更新 `iflow_adapter.rs`**

顶部添加：
```rust
use super::session_params::{
    build_initialize_params, build_session_new_params,
    build_session_new_params_with_id, build_session_load_params, build_prompt_params,
};
```

**Step 3: 注册子模块**

`src-tauri/src/agents/mod.rs` 添加：
```rust
pub mod session_params;
```

**Step 4: 验证**
```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

**Step 5: Commit**
```bash
git add src-tauri/src/agents/session_params.rs src-tauri/src/agents/iflow_adapter.rs src-tauri/src/agents/mod.rs
git commit -m "refactor(backend): extract session_params.rs from iflow_adapter.rs"
```

---

## 阶段 2：前端 lib 层抽离

> **重要：** TypeScript 模块使用 ES Module 语法（`import`/`export`）。Vite 会自动处理 tree-shaking，无需额外配置。

### Task 5：提取 `src/lib/utils.ts`（纯工具函数）

**Files:**
- Create: `src/lib/utils.ts`
- Modify: `src/main.ts`

**Step 1: 新建 `src/lib/utils.ts`**

从 `main.ts` 中搜索并**剪切**以下函数，添加 `export` 关键字：

```bash
grep -n "^function formatTime\|^function escapeHtml\|^function formatSessionMeta\|^function generateAcpSessionId\|^function shortAgentId\|^function getWorkspaceName\|^function decodeHtmlEntities" src/main.ts
```

将找到的函数移入 `src/lib/utils.ts`，每个函数前加 `export`：

```typescript
// src/lib/utils.ts

export function generateAcpSessionId(): string { ... }

export function formatTime(date: Date): string { ... }

export function formatSessionMeta(updatedAt: Date, messageCount: number): string { ... }

export function shortAgentId(agentId: string): string { ... }

export function getWorkspaceName(workspacePath: string): string { ... }

export function decodeHtmlEntities(value: string): string { ... }
```

**Step 2: 在 `main.ts` 顶部添加 import**

```typescript
import { generateAcpSessionId, formatTime, formatSessionMeta, shortAgentId, getWorkspaceName, decodeHtmlEntities } from './lib/utils';
```

**Step 3: 验证 TypeScript 编译**
```bash
npx tsc --noEmit 2>&1 | head -20
```
期望：无错误

**Step 4: Commit**
```bash
git add src/lib/utils.ts src/main.ts
git commit -m "refactor(frontend): extract lib/utils.ts from main.ts"
```

---

### Task 6：提取 `src/lib/html.ts`

**Files:**
- Create: `src/lib/html.ts`
- Modify: `src/main.ts`

**Step 1: 新建 `src/lib/html.ts`**

搜索并剪切：
```bash
grep -n "^function escapeHtml\|^function sanitizeMarkdownUrl" src/main.ts
```

```typescript
// src/lib/html.ts

export function escapeHtml(text: string): string { ... }

export function sanitizeMarkdownUrl(rawUrl: string, usage: 'link' | 'image'): string | null { ... }
```

**Step 2: 更新 `main.ts` import**
```typescript
import { escapeHtml, sanitizeMarkdownUrl } from './lib/html';
```

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/lib/html.ts src/main.ts
git commit -m "refactor(frontend): extract lib/html.ts from main.ts"
```

---

### Task 7：提取 `src/lib/markdown.ts`

**Files:**
- Create: `src/lib/markdown.ts`
- Modify: `src/main.ts`

**Step 1: 搜索 Markdown 相关函数**
```bash
grep -n "^function.*[Mm]arkdown\|^function renderInlineMarkdown\|^function splitMarkdownTableRow\|^function isMarkdownTable\|^function normalizeMarkdown\|^function collectMarkdown\|^function.*[Mm]d" src/main.ts
```

找到后将以下函数**剪切**到 `src/lib/markdown.ts`（加 `export`）：

- `renderInlineMarkdown`
- `splitMarkdownTableRow`
- `isMarkdownTableDelimiter`
- `isMarkdownTableRow`
- `normalizeMarkdownTableCells`
- `collectMarkdownTableBodyRows`
- `renderMarkdownContent`
- `formatMessageContent`（依赖 `renderMarkdownContent`，一起移走）

同时将常量 `MARKDOWN_CODE_BLOCK_PLACEHOLDER_PREFIX` 移入此文件并 `export`。

文件头：
```typescript
// src/lib/markdown.ts
import { escapeHtml, sanitizeMarkdownUrl } from './html';
```

**Step 2: 更新 `main.ts` import**
```typescript
import { renderMarkdownContent, formatMessageContent, MARKDOWN_CODE_BLOCK_PLACEHOLDER_PREFIX } from './lib/markdown';
```

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/lib/markdown.ts src/main.ts
git commit -m "refactor(frontend): extract lib/markdown.ts from main.ts"
```

---

## 阶段 3：前端 services 层抽离

### Task 8：提取 `src/services/tauri.ts`

**Files:**
- Create: `src/services/tauri.ts`
- Modify: `src/main.ts`

**背景：** 将所有 `invoke(...)` 调用封装为类型化函数，`main.ts` 不再直接调用 `invoke`。

**Step 1: 搜索所有 invoke 调用**
```bash
grep -n "invoke(" src/main.ts | head -40
```

**Step 2: 新建 `src/services/tauri.ts`**

根据搜索结果，为每个 invoke 调用创建对应的包装函数：

```typescript
// src/services/tauri.ts
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';

// 连接 iFlow Agent
export async function connectIflow(params: {
  agentId: string;
  iflowPath: string;
  workspacePath: string;
  model?: string;
}): Promise<{ agentId: string; port: number }> {
  return invoke('connect_iflow', params);
}

// 发送消息
export async function sendMessage(params: {
  agentId: string;
  message: string;
  sessionId?: string;
}): Promise<void> {
  return invoke('send_message', params);
}

// 停止消息
export async function stopMessage(agentId: string): Promise<void> {
  return invoke('stop_message', { agentId });
}

// 断开 Agent
export async function disconnectAgent(agentId: string): Promise<void> {
  return invoke('disconnect_agent', { agentId });
}

// 切换模型
export async function switchAgentModel(params: {
  agentId: string;
  modelName: string;
}): Promise<string | null> {
  return invoke('switch_agent_model', params);
}

// 列出可用模型
export async function listAvailableModels(iflowPath: string): Promise<ModelOption[]> {
  return invoke('list_available_models', { iflowPath });
}

// 加载会话快照
export async function loadStorageSnapshotFromBackend(): Promise<StorageSnapshot | null> {
  return invoke('load_storage_snapshot');
}

// 保存会话快照
export async function saveStorageSnapshotToBackend(snapshot: StorageSnapshot): Promise<boolean> {
  return invoke('save_storage_snapshot', { snapshot });
}

// 获取 app 版本
export { getVersion } from '@tauri-apps/api/app';
export { convertFileSrc } from '@tauri-apps/api/core';

// ... 根据 grep 结果补充其他 invoke 调用
```

> 注意：`ModelOption`、`StorageSnapshot` 等类型需要从 `main.ts` 提取到一个共享的 `src/types.ts`，或者在 `tauri.ts` 内 re-export。参见 Task 9 说明。

**Step 3: 更新 `main.ts` 的 import**

删除 `main.ts` 顶部的 `invoke` import，改为：
```typescript
import { connectIflow, sendMessage, stopMessage, disconnectAgent, ... } from './services/tauri';
```

**Step 4: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
git add src/services/tauri.ts src/main.ts
git commit -m "refactor(frontend): extract services/tauri.ts from main.ts"
```

---

### Task 9：提取 `src/types.ts`（共享类型定义）

**Files:**
- Create: `src/types.ts`
- Modify: `src/main.ts`

**背景：** `main.ts` 顶部（约 50–190 行）的 `interface`/`type` 定义需要被多个模块共享，统一放到 `src/types.ts`。

**Step 1: 新建 `src/types.ts`**

从 `main.ts` **剪切**所有 `interface` 和 `type` 定义，全部加 `export`：

```bash
grep -n "^interface \|^type \|^enum " src/main.ts
```

将找到的定义移入 `src/types.ts`：

```typescript
// src/types.ts

export interface Agent { ... }
export interface Session { ... }
export interface Message { ... }
export interface ToolCall { ... }
export interface RegistryCommand { ... }
export interface RegistryMcpServer { ... }
export interface ModelOption { ... }
export interface AgentRegistry { ... }
export interface SlashMenuItem { ... }
export interface StoredSession { ... }
export interface StoredMessage { ... }
export type StoredSessionMap = Record<string, StoredSession[]>;
export type StoredMessageMap = Record<string, StoredMessage[]>;
export type LegacyMessageHistoryMap = Record<string, StoredMessage[]>;
export interface StorageSnapshot { ... }
export interface IflowHistorySessionRecord { ... }
export interface IflowHistoryMessageRecord { ... }
export type ComposerState = 'ready' | 'busy' | 'disabled';
export type StreamMessageType = 'content' | 'thought' | 'system' | 'plan';
export type ThemeMode = 'system' | 'light' | 'dark';
```

**Step 2: 在 `main.ts` 顶部添加 import**
```typescript
import type { Agent, Session, Message, ToolCall, ModelOption, /* ... */ } from './types';
```

**Step 3: 更新 `src/services/tauri.ts`**

将 tauri.ts 中对类型的 inline 定义替换为 import：
```typescript
import type { ModelOption, StorageSnapshot } from '../types';
```

**Step 4: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
git add src/types.ts src/main.ts src/services/tauri.ts
git commit -m "refactor(frontend): extract shared types to src/types.ts"
```

---

### Task 10：提取 `src/services/events.ts`

**Files:**
- Create: `src/services/events.ts`
- Modify: `src/main.ts`

**背景：** `setupTauriEventListeners()`（main.ts ~355 行）内的所有 `listen(...)` 调用封装为类型化事件订阅。

**Step 1: 搜索 listen 调用**
```bash
grep -n "listen(" src/main.ts
```

**Step 2: 新建 `src/services/events.ts`**

```typescript
// src/services/events.ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type StreamMessagePayload = {
  agentId: string;
  sessionId?: string;
  content: string;
  messageType?: string;
};

export type ToolCallPayload = {
  agentId: string;
  toolCallId: string;
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
};

// ... 其他 payload 类型根据 listen 调用补充

export async function onStreamMessage(
  handler: (payload: StreamMessagePayload) => void
): Promise<UnlistenFn> {
  return listen<StreamMessagePayload>('stream-message', (e) => handler(e.payload));
}

export async function onToolCallUpdate(
  handler: (payload: ToolCallPayload) => void
): Promise<UnlistenFn> {
  return listen<ToolCallPayload>('tool-call-update', (e) => handler(e.payload));
}

// ... 根据 grep 结果补充其他事件
```

**Step 3: 在 `main.ts` 替换 `listen` 调用**

将 `setupTauriEventListeners()` 内的 listen 调用替换为 services/events.ts 导出的函数。

**Step 4: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
git add src/services/events.ts src/main.ts
git commit -m "refactor(frontend): extract services/events.ts from main.ts"
```

---

## 阶段 4：前端 features 层抽离

> **注意：** features 层抽离最复杂，因为模块间有共享状态。策略是先创建共享 state 文件，再将操作函数移入对应 actions 文件。

### Task 11：提取 `src/features/storage/index.ts`

**Files:**
- Create: `src/features/storage/index.ts`
- Modify: `src/main.ts`

**Step 1: 搜索存储相关函数**
```bash
grep -n "^async function loadStorageSnapshot\|^async function saveStorageSnapshot\|^async function persistStorageSnapshot\|^function readStorageSnapshot\|^function clearLocalStorage\|^function isStorageSnapshot\|^async function loadSessionStore\|^async function saveSessions\|^async function saveSessionMessages\|^async function migrateLegacy\|^function pruneSessionData\|^function normalizeStoredSessions\|^function normalizeStoredMessages\|^function buildStoredSessionMap\|^function buildStoredMessageMap\|^function buildStorageSnapshot\|^function parseStoredSession\|^function toStoredSession\|^function parseStoredMessage\|^function toStoredMessage\|^function persistCurrentSession" src/main.ts
```

**Step 2: 新建 `src/features/storage/index.ts`**

将找到的函数移入，文件头：
```typescript
// src/features/storage/index.ts
import type { StorageSnapshot, Session, Message, StoredSession, StoredMessage, StoredSessionMap, StoredMessageMap } from '../../types';
import { loadStorageSnapshotFromBackend, saveStorageSnapshotToBackend } from '../../services/tauri';
```

> 存储函数依赖全局 state（`sessionsByAgent`、`messagesBySession` 等），暂时通过参数传入而非直接引用。

**Step 3: 更新 `main.ts`**

添加 import：
```typescript
import { loadSessionStore, saveSessions, saveSessionMessages } from './features/storage';
```

**Step 4: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**
```bash
git add src/features/storage/index.ts src/main.ts
git commit -m "refactor(frontend): extract features/storage from main.ts"
```

---

### Task 12：提取 `src/features/sessions/`

**Files:**
- Create: `src/features/sessions/state.ts`
- Create: `src/features/sessions/actions.ts`
- Modify: `src/main.ts`

**Step 1: 新建 `src/features/sessions/state.ts`**

移出会话相关全局状态：
```typescript
// src/features/sessions/state.ts
import type { Session, Message } from '../../types';

export let sessionsByAgent: Record<string, Session[]> = {};
export let messagesBySession: Record<string, Message[]> = {};
export let currentSessionId: string | null = null;
export let inflightSessionByAgent: Record<string, string> = {};

export function setCurrentSessionId(id: string | null) { currentSessionId = id; }
// ... setter 函数按需添加
```

**Step 2: 新建 `src/features/sessions/actions.ts`**

搜索并移入会话操作函数：
```bash
grep -n "^function startNewSession\|^function clearChat\|^function selectSession\|^function createSession\|^function ensureAgentHasSessions\|^function getSessionsForAgent\|^function getMessagesForSession\|^function findSessionById\|^function touchCurrentSession\|^function touchSessionById\|^function maybeGenerateSessionTitle\|^function makeSessionTitle\|^function makeSessionTitleFromDialogue\|^function composeKeywordTitle\|^function getLatestDialoguePair\|^function commitSessionMessages" src/main.ts
```

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/features/sessions/ src/main.ts
git commit -m "refactor(frontend): extract features/sessions from main.ts"
```

---

### Task 13：提取 `src/features/agents/`

**Files:**
- Create: `src/features/agents/state.ts`
- Create: `src/features/agents/actions.ts`
- Modify: `src/main.ts`

**Step 1: 新建 `src/features/agents/state.ts`**

```typescript
// src/features/agents/state.ts
import type { Agent, AgentRegistry, ModelOption, ToolCall } from '../../types';

export let agents: Agent[] = [];
export let currentAgentId: string | null = null;
export let registryByAgent: Record<string, AgentRegistry> = {};
export let toolCallsByAgent: Record<string, ToolCall[]> = {};
export let modelOptionsCacheByAgent: Record<string, ModelOption[]> = {};
```

**Step 2: 新建 `src/features/agents/actions.ts`**

搜索并移入 Agent 操作函数：
```bash
grep -n "^async function loadAgents\|^async function saveAgents\|^function applyAgentRegistry\|^function applyAgentModelRegistry\|^function applyAcpSessionBinding\|^async function switchAgentModel\|^async function handleLocalModelCommand\|^function resolveModelName\|^function formatModelList\|^function currentAgentModelLabel\|^function syncAgentModelFromAboutContent\|^function extractModelNameFromAboutPayload\|^function parseAboutPayload" src/main.ts
```

**Step 3: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**
```bash
git add src/features/agents/ src/main.ts
git commit -m "refactor(frontend): extract features/agents from main.ts"
```

---

### Task 14：提取 `src/features/ui/`

**Files:**
- Create: `src/features/ui/chat.ts`
- Create: `src/features/ui/sidebar.ts`
- Create: `src/features/ui/composer.ts`
- Create: `src/features/ui/modals.ts`
- Modify: `src/main.ts`

**Step 1: 提取 `chat.ts`**

搜索并移入：
```bash
grep -n "^function renderMessages\|^function appendStreamMessage\|^function showToolCalls\|^function scrollToBottom\|^function showLoading\|^function hideLoading\|^function showSuccess\|^function showError" src/main.ts
```

**Step 2: 提取 `sidebar.ts`**

搜索并移入 Agent 列表和会话列表的渲染函数（`renderAgentList`、`renderSessionList` 等，按 grep 实际结果为准）。

**Step 3: 提取 `composer.ts`**

搜索并移入输入区相关：
```bash
grep -n "^function setSendButtonMode\|^function setComposerState\|^function refreshComposerState\|^function isCurrentAgentBusy\|^function getSlashQueryFromInput\|^function buildSlashMenuItems\|^function updateSlashCommandMenu\|^function hideSlashCommandMenu\|^function ensureSlashMenuActiveItemVisible\|^function moveSlashMenuSelection\|^function applySlashMenuItem\|^function handleSlashMenuKeydown" src/main.ts
```

**Step 4: 提取 `modals.ts`**

搜索并移入：
```bash
grep -n "^function hideModal\|^function onDocumentClick\|^function canUseConversationQuickAction\|^async function sendPresetMessage" src/main.ts
```

**Step 5: 验证**
```bash
npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**
```bash
git add src/features/ui/ src/main.ts
git commit -m "refactor(frontend): extract features/ui from main.ts"
```

---

## 阶段 5：main.ts 瘦身收尾

### Task 15：精简 `main.ts` 为初始化编排

**Files:**
- Modify: `src/main.ts`

**目标：** `main.ts` 只保留：
1. DOM 元素获取（或移入 `src/dom.ts` 再 import）
2. `init()` 函数调用
3. `init()` 内的模块初始化编排

**Step 1: 检查 main.ts 剩余行数**
```bash
wc -l src/main.ts
```

**Step 2: 将剩余内嵌逻辑按职责移入对应模块**

查看还剩哪些函数：
```bash
grep -n "^function \|^async function \|^const.*=.*=>" src/main.ts
```

逐一确认归属，移入对应的 features/ 或 lib/ 模块。

**Step 3: 最终 `main.ts` 结构应为**

```typescript
// src/main.ts
import './styles.css';
import { init } from './app'; // 或直接在此处 inline init

// DOM 引用（或从 src/dom.ts import）
// ...

async function init() {
  await loadSessionStore();
  await loadAgents();
  setupTauriEventListeners();
  setupEventListeners();
  applyTheme(loadThemeMode());
  await syncAppVersion();
}

init().catch(console.error);
```

**Step 4: 验证最终行数**
```bash
wc -l src/main.ts
```
目标：< 200 行

**Step 5: 全量 TypeScript 验证**
```bash
npx tsc --noEmit 2>&1
```
期望：无错误

**Step 6: 全量 Rust 验证**
```bash
cd src-tauri && cargo check 2>&1 | grep "^error"
```

**Step 7: 最终手工验证（必须全部通过）**
- [ ] `npm run tauri:dev` 正常启动
- [ ] Agent 连接正常
- [ ] 消息发送 + 流式回复正常
- [ ] 工具调用面板展示正常
- [ ] 多会话切换正常
- [ ] iFlow 历史会话列表加载正常
- [ ] 主题切换正常

**Step 8: 最终 Commit**
```bash
git add -A
git commit -m "refactor: complete modularization - main.ts < 200 lines"
```

---

## 总结：预期文件结构

**前端：**
```
src/
├── main.ts              # ~150 行（init 编排）
├── types.ts             # 共享类型定义
├── dom.ts               # (可选) DOM 元素引用
├── services/
│   ├── tauri.ts         # invoke 封装
│   └── events.ts        # listen 封装
├── features/
│   ├── agents/state.ts + actions.ts
│   ├── sessions/state.ts + actions.ts
│   ├── ui/chat.ts + sidebar.ts + composer.ts + modals.ts
│   └── storage/index.ts
└── lib/
    ├── markdown.ts
    ├── html.ts
    └── utils.ts
```

**后端：**
```
src-tauri/src/
├── commands.rs          # ~200 行（薄命令层）
├── history.rs           # iFlow 历史读写
├── artifact.rs          # HTML artifact 安全读取
├── model_resolver.rs    # 可执行文件 + 模型解析
└── agents/
    ├── iflow_adapter.rs # WebSocket + ACP 协议
    └── session_params.rs# session 参数构建
```
