# Qwen Only Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前仅支持 iFlow 的桌面工作台一次性切换为仅支持 Qwen Code，并保持现有会话 UI、历史浏览、自动重连、模型切换和本地持久化体验可用。

**Architecture:** 后端移除 WebSocket/端口模型，改为通过 `qwen --acp` 的 stdio NDJSON 连接承载 ACP；前端与 Tauri 的公开命名全部切到 `qwen`，但本地存储文件名和 localStorage key 首阶段保持兼容不变，并在加载时做旧数据归一化迁移。历史读取改为 `~/.qwen/projects/<workspace-key>/chats/*.jsonl`，模型列表改为依赖 ACP 返回的 `models` 元数据和手动输入降级。

**Tech Stack:** Tauri 2、Rust 2021、Tokio、TypeScript、Vite、Vitest

---

### Task 1: 后端公开接口重命名与依赖清理

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/agents/mod.rs`
- Modify: `src-tauri/Cargo.toml`
- Delete: `src-tauri/src/model_resolver.rs`
- Test: `src-tauri/src/models.rs`

- [ ] **Step 1: 先写一个会失败的 Rust 测试，锁定 `ConnectResponse` 不再暴露 `port`**

```rust
#[cfg(test)]
mod tests {
    use super::ConnectResponse;
    use serde_json::json;

    #[test]
    fn connect_response_serializes_without_port() {
        let payload = serde_json::to_value(ConnectResponse {
            success: true,
            error: None,
        })
        .expect("serialize connect response");

        assert_eq!(
            payload,
            json!({
                "success": true,
                "error": null
            })
        );
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test connect_response_serializes_without_port -- --exact`

Expected: FAIL，报错类似“missing field `port`”或断言里多出了 `port` 字段。

- [ ] **Step 3: 更新 `models.rs` 与 `state.rs`，移除 `port` 并把路径语义改为 `qwen_path`**

```rust
// src-tauri/src/models.rs
#[derive(Serialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub error: Option<String>,
}
```

```rust
// src-tauri/src/state.rs
pub struct AgentInstance {
    pub info: AgentInfo,
    pub process: Option<Child>,
    pub qwen_path: String,
    pub model: Option<String>,
    pub(crate) message_sender: Option<MessageSender>,
}
```

- [ ] **Step 4: 更新 `commands.rs` / `main.rs` / `agents/mod.rs` 的公开命名**

```rust
// src-tauri/src/agents/mod.rs
pub mod qwen_adapter;
pub mod session_params;
```

```rust
// src-tauri/src/main.rs
use commands::{
    connect_qwen, discover_skills, disconnect_agent, send_message, shutdown_all_agents, stop_message,
    switch_qwen_model, toggle_agent_think,
};
use history::{
    clear_qwen_history_sessions, delete_qwen_history_session, list_qwen_history_sessions,
    load_qwen_history_messages,
};

// generate_handler!
connect_qwen,
switch_qwen_model,
list_qwen_history_sessions,
load_qwen_history_messages,
delete_qwen_history_session,
clear_qwen_history_sessions,
```

```rust
// src-tauri/src/commands.rs
#[tauri::command]
pub async fn connect_qwen(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    qwen_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String>

#[tauri::command]
pub async fn switch_qwen_model(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    qwen_path: String,
    workspace_path: String,
    model: String,
) -> Result<ConnectResponse, String>
```

- [ ] **Step 5: 删掉 iFlow 静态模型解析链路和不再需要的依赖**

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri = { version = "2.0.0", features = [] }
tauri-plugin-shell = "2.0.0"
tauri-plugin-fs = "2.0.0"
rfd = "0.15"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
futures = "0.3"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "=0.4.38", features = ["serde"] }
time = "=0.3.36"
once_cell = "1"
```

Delete:

```text
src-tauri/src/model_resolver.rs
```

- [ ] **Step 6: 再跑 Rust 测试和检查**

Run: `cd src-tauri && cargo test connect_response_serializes_without_port -- --exact`

Expected: PASS

Run: `cd src-tauri && cargo check`

Expected: PASS，且不再引用 `model_resolver`、`tokio_tungstenite`、`url`、`port`。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/state.rs src-tauri/src/main.rs src-tauri/src/commands.rs src-tauri/src/agents/mod.rs src-tauri/Cargo.toml
git rm src-tauri/src/model_resolver.rs
git commit -m "refactor(backend): rename tauri qwen API surface"
```

### Task 2: 实现 Qwen stdio ACP 适配器并移除 WebSocket 重试循环

**Files:**
- Create: `src-tauri/src/agents/qwen_adapter.rs`
- Delete: `src-tauri/src/agents/iflow_adapter.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/agents/session_params.rs`
- Test: `src-tauri/src/agents/qwen_adapter.rs`

- [ ] **Step 1: 先写会失败的适配器单元测试，锁定 NDJSON 与 iFlow 私有方法移除**

```rust
#[cfg(test)]
mod tests {
    use super::{parse_ndjson_line, should_handle_server_method};
    use serde_json::json;

    #[test]
    fn parse_ndjson_line_reads_single_json_message() {
        let parsed = parse_ndjson_line(r#"{"jsonrpc":"2.0","id":1}"#)
            .expect("parse line")
            .expect("message");
        assert_eq!(parsed, json!({"jsonrpc":"2.0","id":1}));
    }

    #[test]
    fn parse_ndjson_line_ignores_blank_lines() {
        assert!(parse_ndjson_line("   ").expect("blank line").is_none());
    }

    #[test]
    fn private_iflow_methods_are_not_supported() {
        assert!(!should_handle_server_method("_iflow/user/questions"));
        assert!(!should_handle_server_method("_iflow/plan/exit"));
        assert!(should_handle_server_method("fs/read_text_file"));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test parse_ndjson_line_reads_single_json_message -- --exact`

Expected: FAIL，因为 `qwen_adapter.rs` 和相关 helper 还不存在。

- [ ] **Step 3: 新建 `qwen_adapter.rs`，先实现 stdio 连接与 NDJSON 收发**

```rust
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

pub struct StdioAcpConnection {
    writer: ChildStdin,
    reader: Lines<BufReader<ChildStdout>>,
}

impl StdioAcpConnection {
    pub fn new(stdout: ChildStdout, stdin: ChildStdin) -> Self {
        Self {
            writer: stdin,
            reader: BufReader::new(stdout).lines(),
        }
    }

    pub async fn send_message(&mut self, message: &Value) -> Result<(), String> {
        let payload = format!("{}\n", message);
        self.writer
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write ACP stdin: {}", e))?;
        self.writer
            .flush()
            .await
            .map_err(|e| format!("Failed to flush ACP stdin: {}", e))
    }

    pub async fn receive_message(&mut self) -> Result<Option<Value>, String> {
        match self.reader.next_line().await {
            Ok(Some(line)) => parse_ndjson_line(&line),
            Ok(None) => Ok(None),
            Err(error) => Err(format!("Failed to read ACP stdout: {}", error)),
        }
    }
}

pub fn parse_ndjson_line(line: &str) -> Result<Option<Value>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(trimmed)
        .map(Some)
        .map_err(|e| format!("Invalid ACP NDJSON line: {}", e))
}
```

- [ ] **Step 4: 在 `qwen_adapter.rs` 里实现 server request handler，并明确不支持 iFlow 私有方法与 terminal 能力**

```rust
fn should_handle_server_method(method: &str) -> bool {
    matches!(
        method,
        "session/request_permission" | "fs/read_text_file" | "fs/write_text_file"
    )
}

async fn handle_server_request(
    conn: &mut StdioAcpConnection,
    request_id: i64,
    method: &str,
    params: Option<&Value>,
) {
    let response = match method {
        "session/request_permission" => json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": {
                    "outcome": "selected",
                    "optionId": "allow_once"
                }
            }
        }),
        "fs/read_text_file" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing path").await;
                return;
            };
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();

            match tokio::fs::read_to_string(path).await {
                Ok(content) => {
                    let _ = send_rpc_result(
                        conn,
                        request_id,
                        json!({
                            "content": content,
                            "path": path,
                            "sessionId": session_id,
                        }),
                    )
                    .await;
                }
                Err(error) => {
                    let _ = send_rpc_error(
                        conn,
                        request_id,
                        -32603,
                        &format!("Failed to read file: {}", error),
                    )
                    .await;
                }
            }
            return;
        }
        "fs/write_text_file" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing path").await;
                return;
            };
            let Some(content) = params.get("content").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing content").await;
                return;
            };

            match tokio::fs::write(path, content).await {
                Ok(_) => {
                    let _ = send_rpc_result(conn, request_id, Value::Null).await;
                }
                Err(error) => {
                    let _ = send_rpc_error(
                        conn,
                        request_id,
                        -32603,
                        &format!("Failed to write file: {}", error),
                    )
                    .await;
                }
            }
            return;
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32601,
                "message": "Method not found"
            }
        }),
    };

    let _ = conn.send_message(&response).await;
}
```

- [ ] **Step 5: 重写 `message_listener_task`，移除 WebSocket 5 次重试循环**

```rust
pub async fn message_listener_task(
    app_handle: tauri::AppHandle,
    agent_id: String,
    workspace_path: String,
    stdout: ChildStdout,
    stdin: ChildStdin,
    mut message_rx: tokio::sync::mpsc::UnboundedReceiver<ListenerCommand>,
) {
    let mut conn = StdioAcpConnection::new(stdout, stdin);
    let mut rpc_id_counter: i64 = 1;
    let mut cached_session_id: Option<String> = None;

    let init_request = json!({
        "jsonrpc": "2.0",
        "id": rpc_id_counter,
        "method": "initialize",
        "params": build_initialize_params(),
    });
    if conn.send_message(&init_request).await.is_err() {
        return;
    }
    rpc_id_counter += 1;

    loop {
        tokio::select! {
            command = message_rx.recv() => {
                // 继续处理 UserPrompt / CancelPrompt / SetModel / SetThink
            }
            message = conn.receive_message() => {
                match message {
                    Ok(Some(payload)) => {
                        // 继续沿用现有 ACP session/update 路由逻辑
                    }
                    Ok(None) | Err(_) => {
                        let _ = app_handle.emit("agent-error", json!({
                            "agentId": agent_id,
                            "error": "Qwen ACP connection closed"
                        }));
                        return;
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 6: 在 `commands.rs` 用 stdio 启动 Qwen，并用独立 task 监听 `child.wait()`**

```rust
let mut cmd = Command::new(&resolved_qwen_path);
cmd.current_dir(&workspace_path)
    .arg("--acp")
    .env("PATH", runtime_path)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

if let Some(model_name) = model.as_ref().filter(|m| !m.trim().is_empty()) {
    cmd.arg("--model").arg(model_name.trim());
}

let mut child = cmd.spawn().map_err(|e| format!("Failed to start Qwen: {}", e))?;
let stdout = child.stdout.take().ok_or_else(|| "Qwen stdout unavailable".to_string())?;
let stdin = child.stdin.take().ok_or_else(|| "Qwen stdin unavailable".to_string())?;
let stderr = child.stderr.take().ok_or_else(|| "Qwen stderr unavailable".to_string())?;

tokio::spawn(async move {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[qwen-stderr] {}", line);
    }
});

tokio::spawn(async move {
    match child.wait().await {
        Ok(status) => eprintln!("[qwen-exit] {}", status),
        Err(error) => eprintln!("[qwen-exit-error] {}", error),
    }
});
```

- [ ] **Step 7: 跑 adapter 相关测试和 `cargo check`**

Run: `cd src-tauri && cargo test parse_ndjson_line_reads_single_json_message private_iflow_methods_are_not_supported`

Expected: PASS

Run: `cd src-tauri && cargo check`

Expected: PASS，且不再引用 `tokio_tungstenite`、`find_available_port()`、`ws://127.0.0.1:<port>/acp`。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/agents/qwen_adapter.rs src-tauri/src/commands.rs src-tauri/src/agents/mod.rs src-tauri/src/agents/session_params.rs
git rm src-tauri/src/agents/iflow_adapter.rs
git commit -m "feat(backend): switch ACP transport to qwen stdio"
```

### Task 3: 实现 Qwen 历史解析与后端会话命名迁移

**Files:**
- Modify: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/history.rs`

- [ ] **Step 1: 先写会失败的 Rust 测试，锁定 Qwen 历史格式**

```rust
#[cfg(test)]
mod tests {
    use super::{compact_title, normalize_qwen_session_id};

    #[test]
    fn normalize_qwen_session_id_accepts_uuid_jsonl() {
        assert_eq!(
            normalize_qwen_session_id("464a05db-d441-44fb-a696-f920a0e49ae4.jsonl").unwrap(),
            "464a05db-d441-44fb-a696-f920a0e49ae4"
        );
    }

    #[test]
    fn compact_title_falls_back_to_qwen_session() {
        assert_eq!(compact_title("   "), "Qwen 会话");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test normalize_qwen_session_id_accepts_uuid_jsonl compact_title_falls_back_to_qwen_session`

Expected: FAIL，因为当前还是 `normalize_iflow_session_id` 与 `"iFlow 会话"`。

- [ ] **Step 3: 把 history 里的 `iflow` 命名整体改成 `qwen`，并复用 project key 算法**

```rust
fn workspace_to_qwen_project_key(workspace_path: &str) -> String {
    let normalized = normalize_workspace_path(workspace_path);
    let mut key = normalized.replace('/', "-").replace(':', "-");
    if !key.starts_with('-') {
        key = format!("-{}", key);
    }
    key
}

fn qwen_projects_root() -> Result<PathBuf, String> {
    let home_dir = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|e| format!("HOME/USERPROFILE is not set: {}", e))?;
    Ok(PathBuf::from(home_dir).join(".qwen").join("projects"))
}

fn normalize_qwen_session_id(session_id: &str) -> Result<String, String> {
    let normalized = session_id.trim().trim_end_matches(".jsonl").to_string();
    if normalized.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    Ok(normalized)
}
```

- [ ] **Step 4: 让消息解析直接适配 Qwen JSONL 里的 `timestamp`、`cwd`、`message.parts`**

```rust
fn compact_title(raw: &str) -> String {
    let normalized = raw.replace('\n', " ").replace('\r', " ").trim().to_string();
    if normalized.is_empty() {
        return "Qwen 会话".to_string();
    }
    if normalized.chars().count() <= 28 {
        return normalized;
    }
    format!("{}...", normalized.chars().take(28).collect::<String>())
}

fn extract_history_timestamp(record: &Value) -> Option<String> {
    record.get("timestamp").and_then(Value::as_str).map(str::to_string)
}

fn extract_history_record_cwd(record: &Value) -> Option<String> {
    record.get("cwd").and_then(Value::as_str).map(str::to_string)
}
```

```rust
fn extract_history_message_content(record: &Value, record_type: &str) -> Option<String> {
    if record_type != "user" && record_type != "assistant" {
        return None;
    }
    let parts = record.get("message")?.get("parts")?.as_array()?;
    let text_items = parts
        .iter()
        .filter(|item| !item.get("thought").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();

    if text_items.is_empty() {
        None
    } else {
        Some(text_items.join("\n"))
    }
}
```

- [ ] **Step 5: 重命名公开历史命令并在 `main.rs` 注册新名字**

```rust
pub async fn list_iflow_history_sessions -> pub async fn list_qwen_history_sessions
pub async fn load_iflow_history_messages -> pub async fn load_qwen_history_messages
pub async fn delete_iflow_history_session -> pub async fn delete_qwen_history_session
pub async fn clear_iflow_history_sessions -> pub async fn clear_qwen_history_sessions
```

- [ ] **Step 6: 跑 Rust 历史测试**

Run: `cd src-tauri && cargo test normalize_qwen_session_id_accepts_uuid_jsonl compact_title_falls_back_to_qwen_session`

Expected: PASS

Run: `cd src-tauri && cargo test`

Expected: PASS，且历史读取逻辑只使用 `~/.qwen/projects/.../chats/*.jsonl`。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/history.rs src-tauri/src/main.rs
git commit -m "feat(history): parse qwen chat history files"
```

### Task 4: 前端 Qwen API 接线、Agent 迁移与会话来源归一化

**Files:**
- Modify: `src/types.ts`
- Modify: `src/services/tauri.ts`
- Modify: `src/features/agents/actions.ts`
- Modify: `src/features/agents/reconnect.ts`
- Modify: `src/features/agents/model.ts`
- Modify: `src/features/sessions/index.ts`
- Modify: `src/features/storage/index.ts`
- Modify: `src/store.ts`
- Modify: `src/features/app.ts`
- Test: `src/features/agents/reconnect.test.ts`
- Test: `src/features/storage/index.test.ts`

- [ ] **Step 1: 先写两个会失败的 Vitest 用例，锁定旧数据归一化**

```ts
// src/features/storage/index.test.ts
import { describe, expect, it } from 'vitest';
import { parseStoredSession } from './index';

describe('parseStoredSession', () => {
  it('migrates iflow-log source to qwen-log', () => {
    const session = parseStoredSession({
      id: 'iflowlog-agent-1-session-1',
      agentId: 'agent-1',
      title: '',
      createdAt: '2026-04-12T00:00:00.000Z',
      updatedAt: '2026-04-12T00:00:00.000Z',
      acpSessionId: '464a05db-d441-44fb-a696-f920a0e49ae4',
      source: 'iflow-log',
    });

    expect(session.source).toBe('qwen-log');
  });
});
```

```ts
// src/features/agents/reconnect.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeAutoReconnectMode, AUTO_RECONNECT_MODE_DEFAULT } from './reconnect';

describe('normalizeAutoReconnectMode', () => {
  it('returns default for empty', () => {
    expect(normalizeAutoReconnectMode('')).toBe(AUTO_RECONNECT_MODE_DEFAULT);
  });
});
```

- [ ] **Step 2: 跑前端测试确认至少有一个失败**

Run: `npm test -- src/features/storage/index.test.ts`

Expected: FAIL，因为当前 `parseStoredSession()` 仍返回 `iflow-log`。

- [ ] **Step 3: 重命名前端类型、Tauri wrapper 和 Agent 字段**

```ts
// src/types.ts
export interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  qwenPath?: string;
  selectedModel?: string;
  thinkEnabled?: boolean;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  acpSessionId?: string;
  source?: 'local' | 'qwen-log';
  messageCountHint?: number;
}
```

```ts
// src/services/tauri.ts
export interface ConnectQwenResult {
  success: boolean;
  error?: string;
}

export function connectQwen(
  agentId: string,
  qwenPath: string,
  workspacePath: string,
  model: string | null,
): Promise<ConnectQwenResult> {
  return invoke<ConnectQwenResult>('connect_qwen', { agentId, qwenPath, workspacePath, model });
}
```

- [ ] **Step 4: 在 `actions.ts` / `reconnect.ts` / `model.ts` 中切换到 Qwen 语义**

```ts
// src/features/agents/actions.ts
export async function addAgent(name: string, qwenPath: string, workspacePath: string) {
  const agentId = `qwen-${Date.now()}`;
  const result = await connectQwen(agentId, qwenPath, workspacePath, null);

  const agent: Agent = {
    id: agentId,
    name,
    type: 'qwen',
    status: 'connected',
    workspacePath,
    qwenPath,
    thinkEnabled: false,
  };
}
```

```ts
// src/features/agents/reconnect.ts
const result = await connectQwen(
  agent.id,
  agent.qwenPath || 'qwen',
  agent.workspacePath,
  agent.selectedModel || null,
);
```

```ts
// src/features/agents/model.ts
const result = await switchQwenModel(
  agent.id,
  agent.qwenPath || 'qwen',
  agent.workspacePath,
  targetModel,
);
```

- [ ] **Step 5: 让 `loadAgents()` 和 `parseStoredSession()` 处理旧数据迁移**

```ts
// src/features/agents/actions.ts
state.agents = (JSON.parse(saved) as Agent[]).map((agent) => ({
  ...agent,
  type: 'qwen',
  qwenPath: (agent as Agent & { iflowPath?: string }).qwenPath
    || (agent as Agent & { iflowPath?: string }).iflowPath
    || 'qwen',
  thinkEnabled: Boolean(agent.thinkEnabled),
  status: 'disconnected' as const,
}));
```

```ts
// src/features/storage/index.ts
const normalizedSource =
  session.source === 'iflow-log'
    ? 'qwen-log'
    : session.source === 'qwen-log'
      ? 'qwen-log'
      : 'local';
```

- [ ] **Step 6: 更新 `sessions/index.ts` 和 `app.ts` 中所有 `iflow-log` 判断分支**

```ts
if (targetSession.source === 'qwen-log') {
  return;
}

const sourceMessages =
  targetSession?.source === 'qwen-log'
    ? getMessagesForSession(requestSessionId)
    : [];
```

- [ ] **Step 7: 保留 localStorage key 不变，但只改文案和默认 CLI 路径**

```ts
// src/store.ts
const NOTIFICATION_DELAY_STORAGE_KEY = 'iflow-notification-delay-ms';
const SEND_KEY_MODE_STORAGE_KEY = 'iflow-send-key-mode';
const HISTORY_CONTINUATION_STORAGE_KEY = 'iflow-history-continuation-enabled';
```

```ts
// src/features/app.ts
const qwenPath = pathInput.value.trim() || 'qwen';
await addAgent(name, qwenPath, workspacePath);
```

- [ ] **Step 8: 跑前端测试**

Run: `npm test -- src/features/storage/index.test.ts src/features/agents/reconnect.test.ts src/features/agents/model.test.ts`

Expected: PASS

Run: `npm run build`

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/services/tauri.ts src/features/agents/actions.ts src/features/agents/reconnect.ts src/features/agents/model.ts src/features/sessions/index.ts src/features/storage/index.ts src/store.ts src/features/app.ts src/features/storage/index.test.ts src/features/agents/reconnect.test.ts
git commit -m "feat(frontend): migrate agent flows to qwen"
```

### Task 5: 端到端验证与启动新开发服务

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Test: `src-tauri/src/history.rs`
- Test: `src/features/storage/index.test.ts`

- [ ] **Step 1: 补 README 和脚本文案中的 Qwen 默认值**

```md
## Prerequisites

- 安装 Qwen Code CLI
- 确认可执行：`qwen --help`
- 历史会话目录：`~/.qwen/projects/<workspace-key>/chats/*.jsonl`
```

- [ ] **Step 2: 运行完整验证命令**

Run: `cd src-tauri && cargo test`

Expected: PASS

Run: `npm test`

Expected: PASS

Run: `npm run build`

Expected: PASS

- [ ] **Step 3: 清理旧开发进程并启动新的前端服务**

Run: `npm run kill`

Expected: PASS，旧开发进程被清理。

Run: `npm run dev`

Expected: Vite 在 `http://127.0.0.1:1420` 或终端提示的本地地址启动成功。

- [ ] **Step 4: 如果需要完整桌面联调，再启动 Tauri**

Run: `npm run tauri:dev`

Expected: Tauri 开发窗口启动成功，能够添加 `Qwen` Agent、发送消息、停止生成、查看 Qwen 历史、刷新后自动重连。

- [ ] **Step 5: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "docs: update runtime instructions for qwen"
```
