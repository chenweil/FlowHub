# Qwen Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 FlowHub 应用从 iFlow ACP WebSocket 接入彻底切换为 Qwen Code stdio ACP 接入。

**Architecture:** 替换后端 ACP 传输层从 WebSocket 改为 stdio，复用现有 ACP 状态机和事件分发逻辑；重写历史解析层适配 Qwen JSONL 结构；统一前端/后端命名从 `iflow` 改为 `qwen`。

**Tech Stack:** Rust + Tokio + Tauri 2.0 (后端), TypeScript + Vite (前端), ACP JSON-RPC over stdio (协议)

---

## 重要说明：存储 Key 保持不变

根据设计文档 §持久化兼容策略，以下存储 key **首阶段保持不变**：
- Tauri 存储文件名：`iflow-session-store-<env>.json`（不变）
- localStorage key：`iflow-*` 系列 key（不变）

这确保旧数据可以平滑迁移，用户不会丢失历史记录。

---

## File Structure

### 后端文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/Cargo.toml` | 修改 | 移除 tokio-tungstenite、url 依赖 |
| `src-tauri/src/agents/iflow_adapter.rs` | 重命名+重写 | → `qwen_adapter.rs`，stdio 传输实现 |
| `src-tauri/src/agents/mod.rs` | 修改 | 模块导出改名 |
| `src-tauri/src/agents/session_params.rs` | 保留 | ACP 参数构建复用 |
| `src-tauri/src/commands.rs` | 重写 | 所有函数/命令重命名，启动逻辑改为 stdio |
| `src-tauri/src/state.rs` | 修改 | `iflow_path` → `qwen_path`，移除 `port` 字段 |
| `src-tauri/src/models.rs` | 修改 | `agent_type` 改为 `qwen`，移除 `ConnectResponse.port` |
| `src-tauri/src/history.rs` | 重写 | Qwen JSONL 解析，所有函数重命名 |
| `src-tauri/src/main.rs` | 修改 | 所有命令注册重命名，移除 model_resolver 导入 |
| `src-tauri/src/model_resolver.rs` | **删除** | 不再需要静态模型解析 |

### 前端文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/services/tauri.ts` | 重写 | 所有函数重命名 |
| `src/types.ts` | 修改 | `iflowPath` → `qwenPath`，`source` 类型修改 |
| `src/features/agents/actions.ts` | 修改 | 默认值改为 qwen，添加旧数据归一化逻辑 |
| `src/features/agents/reconnect.ts` | 修改 | 重连逻辑适配 |
| `src/features/agents/model.ts` | 修改 | 模型切换适配 |
| `src/features/sessions/index.ts` | 修改 | 历史同步函数调用重命名 |
| `src/features/storage/index.ts` | 修改 | 添加旧数据归一化逻辑 |
| `index.html` | 修改 | 文案改为 Qwen，主题存储 key 修改 |

---

## Task 0: 更新 Cargo.toml

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 移除 WebSocket 相关依赖**

修改 `src-tauri/Cargo.toml`，删除以下依赖：
```toml
# 删除这些行
tokio-tungstenite = "0.21"
url = "2"
```

- [ ] **Step 2: 更新 package 信息**

```toml
[package]
name = "qwen-workspace"  # iflow-workspace -> qwen-workspace
description = "Multi-Agent Desktop App for Qwen Code"
```

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo check`
Expected: 编译错误（缺少依赖），确认删除成功

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "chore(backend): remove WebSocket deps, update package info for Qwen"
```

---

## Task 1: 后端文件重命名与模块导出修改

**Files:**
- Rename: `src-tauri/src/agents/iflow_adapter.rs` → `src-tauri/src/agents/qwen_adapter.rs`
- Modify: `src-tauri/src/agents/mod.rs`

- [ ] **Step 1: 重命名适配器文件**

```bash
cd src-tauri/src/agents
git mv iflow_adapter.rs qwen_adapter.rs
```

- [ ] **Step 2: 更新模块导出**

修改 `src-tauri/src/agents/mod.rs`:

```rust
pub mod qwen_adapter;
pub mod session_params;
```

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo check`
Expected: 编译错误（引用旧模块名），确认文件重命名成功

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agents/
git commit -m "refactor(backend): rename iflow_adapter.rs to qwen_adapter.rs"
```

---

## Task 2: 后端状态结构重命名

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/models.rs`

- [ ] **Step 1: 修改 AgentInstance 结构体**

修改 `src-tauri/src/state.rs`:

```rust
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::manager::AgentManager;
use crate::models::{AgentInfo, MessageSender};

// Agent 实例
#[allow(dead_code)]
pub struct AgentInstance {
    pub info: AgentInfo,
    pub process: Option<Child>,
    pub qwen_path: String,  // iflow_path -> qwen_path
    pub model: Option<String>,
    pub(crate) message_sender: Option<MessageSender>,
    // 注意：port 字段已删除
}
```

- [ ] **Step 2: 修改 ConnectResponse 移除 port**

修改 `src-tauri/src/models.rs`:

```rust
// 连接响应
#[derive(Serialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub error: Option<String>,
    // 注意：port 字段已删除
}
```

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo check`
Expected: 编译错误（其他文件引用旧字段名）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/models.rs
git commit -m "refactor(backend): rename iflow_path to qwen_path, remove port fields"
```

---

## Task 3: 重写 commands.rs 命令层 - 辅助函数

**Files:**
- Modify: `src-tauri/src/commands.rs`

此任务拆分为多个子任务。本任务只处理辅助函数和导入。

- [ ] **Step 1: 更新导入**

修改 `src-tauri/src/commands.rs` 开头的导入：

```rust
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::State;
use tokio::process::{Child, Command};
use tokio::time::{timeout, Duration};

use crate::agents::qwen_adapter::message_listener_task;
use crate::models::{AgentInfo, AgentStatus, ConnectResponse, ListenerCommand, SkillRuntimeItem};
use crate::runtime_env::{resolve_executable_path, runtime_path_env};
use crate::state::{AgentInstance, AppState};
```

- [ ] **Step 2: 重写 terminate_agent_process 函数**

```rust
async fn terminate_agent_process(process: &mut Child) {
    let pid = process.id();

    #[cfg(unix)]
    if let Some(pid) = pid {
        let pid = pid.to_string();
        let _ = Command::new("pkill")
            .arg("-TERM")
            .arg("-P")
            .arg(&pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }

    let _ = process.kill().await;
    let _ = timeout(Duration::from_secs(2), process.wait()).await;

    #[cfg(unix)]
    if let Some(pid) = pid {
        let pid = pid.to_string();
        let _ = Command::new("pkill")
            .arg("-KILL")
            .arg("-P")
            .arg(&pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

async fn terminate_agent_instance(instance: &mut AgentInstance) {
    if let Some(mut process) = instance.process.take() {
        terminate_agent_process(&mut process).await;
    }
}

pub async fn shutdown_all_agents(state: &AppState) {
    let mut instances = state.agent_manager.take_all().await;
    for instance in &mut instances {
        terminate_agent_instance(instance).await;
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(backend): update commands.rs imports and helper functions"
```

---

## Task 4: 重写 commands.rs 命令层 - spawn_qwen_agent

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: 重写 spawn_qwen_agent 函数**

```rust
async fn spawn_qwen_agent(
    app_handle: tauri::AppHandle,
    state: &AppState,
    agent_id: String,
    qwen_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    println!("Connecting to Qwen...");
    println!("Agent ID: {}", agent_id);
    println!("Workspace: {}", workspace_path);
    if let Some(model_name) = model.as_ref() {
        println!("Model override: {}", model_name);
    }

    let resolved_qwen_path = resolve_executable_path(&qwen_path)?;
    let runtime_path = runtime_path_env()?;
    println!("Resolved Qwen executable: {}", resolved_qwen_path.display());

    // 启动 Qwen 进程，使用 stdio ACP
    let mut cmd = Command::new(&resolved_qwen_path);
    cmd.current_dir(&workspace_path)
        .arg("--acp")
        .env("PATH", runtime_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(model_name) = model.as_ref() {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cmd.arg("--model").arg(trimmed);
        }
    }

    println!("Spawning Qwen process...");
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Qwen: {}", e))?;
    println!("Qwen process started, PID: {:?}", child.id());

    // 获取 stdin/stdout/stderr
    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    // 创建消息发送通道
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ListenerCommand>();

    // 保存 Agent 实例
    let agent_info = AgentInfo {
        id: agent_id.clone(),
        name: "Qwen".to_string(),
        agent_type: "qwen".to_string(),
        status: AgentStatus::Connected,
        workspace_path: workspace_path.clone(),
        port: None,
    };

    let instance = AgentInstance {
        info: agent_info,
        process: Some(child),
        qwen_path: qwen_path.clone(),
        model: model.clone(),
        message_sender: Some(tx),
    };

    state.agent_manager.upsert(agent_id.clone(), instance).await;
    let (agent_count, agent_ids) = state.agent_manager.stats().await;
    println!("[connect] Agent saved, total agents: {}", agent_count);

    // 启动后台消息监听任务
    let app_handle_clone = app_handle.clone();
    let agent_id_clone = agent_id.clone();
    let workspace_path_clone = workspace_path.clone();

    tokio::spawn(async move {
        message_listener_task(
            app_handle_clone,
            agent_id_clone,
            stdin,
            stdout,
            stderr,
            workspace_path_clone,
            rx,
        )
        .await;
    });

    println!("Agent {} connected successfully", agent_id);

    Ok(ConnectResponse {
        success: true,
        error: None,
    })
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(backend): add spawn_qwen_agent with stdio ACP"
```

---

## Task 5: 重写 commands.rs 命令层 - Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: 重命名 Tauri 命令函数**

```rust
/// 连接 Qwen
#[tauri::command]
pub async fn connect_qwen(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    qwen_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    spawn_qwen_agent(
        app_handle,
        &state,
        agent_id,
        qwen_path,
        workspace_path,
        model,
    )
    .await
}

/// 切换模型
#[tauri::command]
pub async fn switch_agent_model(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    qwen_path: String,
    workspace_path: String,
    model: String,
) -> Result<ConnectResponse, String> {
    let target_model = model.trim();
    if target_model.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }

    // 尝试通过 ACP 切换模型
    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if agent_exists {
        if let Some(sender) = sender {
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
            let send_result = sender.send(ListenerCommand::SetModel {
                model: target_model.to_string(),
                response: tx,
            });

            if send_result.is_ok() {
                match timeout(Duration::from_secs(20), rx).await {
                    Ok(Ok(Ok(_))) => {
                        return Ok(ConnectResponse { success: true, error: None });
                    }
                    _ => {
                        println!("[switch_agent_model] ACP switch failed, fallback to restart");
                    }
                }
            }
        }
    }

    // 回退：重启 Agent
    if let Some(mut instance) = state.agent_manager.remove(&agent_id).await {
        terminate_agent_instance(&mut instance).await;
    }

    spawn_qwen_agent(
        app_handle,
        &state,
        agent_id,
        qwen_path,
        workspace_path,
        Some(target_model.to_string()),
    )
    .await
}
```

- [ ] **Step 2: 重命名技能发现函数**

```rust
fn resolve_qwen_skill_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home.join(".qwen").join("skills"))
}

#[tauri::command]
pub async fn discover_skills(agent_type: String) -> Result<Vec<SkillRuntimeItem>, String> {
    let normalized_agent_type = agent_type.trim().to_lowercase();
    if normalized_agent_type != "qwen" {
        return Ok(Vec::new());
    }

    let root = resolve_qwen_skill_root()?;
    if !root.exists() {
        return Err(format!("技能目录不存在: {}", root.display()));
    }

    let mut skills: Vec<SkillRuntimeItem> = Vec::new();
    let mut seen = HashSet::<String>::new();

    let mut dir_entries: Vec<_> = std::fs::read_dir(&root)
        .map_err(|e| format!("读取技能目录失败: {}", e))?
        .filter_map(|entry| entry.ok())
        .collect();
    dir_entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in dir_entries {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let skill_md_path = path.join("SKILL.md");
        if !skill_md_path.is_file() { continue; }

        let content = match std::fs::read_to_string(&skill_md_path) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let (manifest_name, manifest_description) = parse_skill_frontmatter(&content);
        let fallback_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let skill_name = manifest_name
            .filter(|n| !n.is_empty())
            .unwrap_or(fallback_name);
        if skill_name.is_empty() { continue; }

        let dedupe_key = skill_name.to_lowercase();
        if seen.contains(&dedupe_key) { continue; }
        seen.insert(dedupe_key);

        skills.push(SkillRuntimeItem {
            agent_type: "qwen".to_string(),
            skill_name: skill_name.clone(),
            title: skill_name,
            description: manifest_description.unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            source: "qwen-cli-dir".to_string(),
            discovered_at: chrono::Utc::now().timestamp_millis(),
        });
    }

    Ok(skills)
}
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(backend): rename Tauri commands for Qwen"
```

---

## Task 6: 删除 model_resolver.rs

**Files:**
- Delete: `src-tauri/src/model_resolver.rs`

- [ ] **Step 1: 删除文件**

```bash
rm src-tauri/src/model_resolver.rs
```

- [ ] **Step 2: 更新 main.rs 移除导入**

修改 `src-tauri/src/main.rs`，删除：
```rust
mod model_resolver;
// ...
use model_resolver::list_available_models;
```

从 `invoke_handler` 中删除：
```rust
list_available_models,
```

- [ ] **Step 3: 在 commands.rs 添加硬编码模型列表**

```rust
#[tauri::command]
pub async fn list_available_models(_qwen_path: String) -> Result<Vec<ModelOption>, String> {
    // 连接前返回常用模型列表，连接后通过 ACP 获取实际列表
    Ok(vec![
        ModelOption { label: "qwen-max".to_string(), value: "qwen-max".to_string() },
        ModelOption { label: "qwen-plus".to_string(), value: "qwen-plus".to_string() },
        ModelOption { label: "qwen-turbo".to_string(), value: "qwen-turbo".to_string() },
    ])
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/
git commit -m "refactor(backend): delete model_resolver.rs, add hardcoded model list"
```

---

## Task 7: 更新 main.rs 命令注册

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: 更新导入和命令注册**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Manager;

mod agents;
mod artifact;
mod commands;
mod dialog;
mod git;
mod history;
mod manager;
mod models;
mod router;
mod runtime_env;
mod state;
mod storage;

use artifact::{read_html_artifact, resolve_html_artifact_path};
use commands::{
    connect_qwen, discover_skills, disconnect_agent, list_available_models,
    send_message, shutdown_all_agents, stop_message, switch_agent_model, toggle_agent_think,
};
use dialog::pick_folder;
use git::{list_git_changes, load_git_file_diff};
use history::{
    clear_qwen_history_sessions, delete_qwen_history_session, list_qwen_history_sessions,
    load_qwen_history_messages,
};
use state::AppState;
use storage::{load_storage_snapshot, save_storage_snapshot};

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_qwen,
            send_message,
            stop_message,
            switch_agent_model,
            toggle_agent_think,
            list_available_models,
            list_qwen_history_sessions,
            load_qwen_history_messages,
            delete_qwen_history_session,
            clear_qwen_history_sessions,
            list_git_changes,
            load_git_file_diff,
            resolve_html_artifact_path,
            read_html_artifact,
            disconnect_agent,
            load_storage_snapshot,
            save_storage_snapshot,
            pick_folder,
            discover_skills,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let cleanup_done = Arc::new(AtomicBool::new(false));

    app.run(move |app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) && cleanup_done
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(shutdown_all_agents(&state));
        }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "refactor(backend): update main.rs command registration for Qwen"
```

---

## Task 8: 重写 history.rs - 结构体和辅助函数

**Files:**
- Rewrite: `src-tauri/src/history.rs`

分多个子任务完成。

- [ ] **Step 1: 重写结构体和基础辅助函数**

```rust
//! Qwen 历史会话文件读取与解析

use std::collections::HashSet;
use std::env;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenHistorySession {
    pub session_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenHistoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

fn normalize_workspace_path(workspace_path: &str) -> String {
    let mut normalized = workspace_path.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn is_same_or_ancestor(base: &str, path: &str) -> bool {
    if base == path { return true; }
    if base == "/" { return path.starts_with('/'); }
    path.starts_with(&format!("{}/", base))
}

fn workspace_path_matches(expected: &str, actual: &str) -> bool {
    let expected = normalize_workspace_path(expected);
    let actual = normalize_workspace_path(actual);
    is_same_or_ancestor(&expected, &actual) || is_same_or_ancestor(&actual, &expected)
}

fn workspace_to_qwen_project_key(workspace_path: &str) -> String {
    let normalized = normalize_workspace_path(workspace_path);
    let mut key = normalized.replace('/', "-").replace(':', "-");
    if !key.starts_with('-') {
        key = format!("-{}", key);
    }
    key
}

fn qwen_projects_root() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|e| format!("HOME/USERPROFILE is not set: {}", e))?;
    Ok(PathBuf::from(home).join(".qwen").join("projects"))
}

fn qwen_project_dirs_for_workspace(workspace: &str, normalized: &str) -> Result<Vec<PathBuf>, String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for path in [workspace, normalized] {
        let key = workspace_to_qwen_project_key(path);
        if seen.insert(key.clone()) {
            candidates.push(qwen_projects_root()?.join(key));
        }
    }
    Ok(candidates)
}

fn compact_title(raw: &str) -> String {
    let normalized = raw.replace('\n', " ").trim().to_string();
    if normalized.is_empty() { return "Qwen 会话".to_string(); }
    if normalized.chars().count() <= 28 { return normalized; }
    format!("{}...", normalized.chars().take(28).collect::<String>())
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "refactor(backend): rewrite history.rs structs and helpers"
```

---

## Task 9: 重写 history.rs - Qwen JSONL 解析

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 实现 message.parts 解析**

```rust
/// 从 Qwen message.parts 数组中提取文本
fn extract_text_from_parts(parts: &Value) -> Option<String> {
    let Value::Array(items) = parts else { return None };

    let mut text_parts = Vec::new();
    for item in items {
        // 跳过思考内容
        if item.get("thought").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        // 跳过 functionCall
        if item.get("functionCall").is_some() {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                text_parts.push(trimmed.to_string());
            }
        }
    }

    if text_parts.is_empty() { None } else { Some(text_parts.join("\n")) }
}

fn extract_history_content(record: &Value, record_type: &str) -> Option<String> {
    if record_type != "user" && record_type != "assistant" { return None; }
    let parts = record.get("message").and_then(|m| m.get("parts"))?;
    extract_text_from_parts(parts)
}

fn extract_history_timestamp(record: &Value) -> Option<String> {
    record.get("timestamp").and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn extract_history_cwd(record: &Value) -> Option<String> {
    record.get("cwd").and_then(Value::as_str).map(normalize_workspace_path)
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "refactor(backend): add Qwen JSONL parsing functions"
```

---

## Task 10: 重写 history.rs - parse_qwen_history_summary

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 实现 parse_qwen_history_summary 函数**

```rust
async fn parse_qwen_history_summary(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Option<QwenHistorySession>, String> {
    let raw = tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;
    let metadata = tokio::fs::metadata(file_path).await.ok();
    let fallback_ts = to_rfc3339_or_now(metadata.and_then(|m| m.modified().ok()));

    let mut created_at: Option<String> = None;
    let mut updated_at: Option<String> = None;
    let mut title: Option<String> = None;
    let mut message_count = 0_usize;
    let mut has_cwd = false;
    let mut workspace_matches = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let Ok(record) = serde_json::from_str::<Value>(trimmed) else { continue; };

        let record_type = record.get("type").and_then(Value::as_str).unwrap_or_default().trim();
        if record_type != "user" && record_type != "assistant" { continue; }

        if let Some(cwd) = extract_history_cwd(&record) {
            has_cwd = true;
            if workspace_path_matches(expected_workspace_path, &cwd) {
                workspace_matches = true;
            }
        }

        let Some(content) = extract_history_content(&record, record_type) else { continue; };
        message_count += 1;

        if let Some(ts) = extract_history_timestamp(&record) {
            if created_at.is_none() { created_at = Some(ts.clone()); }
            updated_at = Some(ts);
        }

        if title.is_none() && record_type == "user" {
            title = Some(content);
        }
    }

    if has_cwd && !workspace_matches { return Ok(None); }

    Ok(Some(QwenHistorySession {
        session_id: session_id.to_string(),
        title: compact_title(title.as_deref().unwrap_or(session_id)),
        created_at: created_at.unwrap_or_else(|| fallback_ts.clone()),
        updated_at: updated_at.unwrap_or(fallback_ts),
        message_count,
    }))
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "feat(backend): add parse_qwen_history_summary function"
```

---

## Task 11: 重写 history.rs - parse_qwen_history_messages

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 实现 parse_qwen_history_messages 函数**

```rust
async fn parse_qwen_history_messages(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Vec<QwenHistoryMessage>, String> {
    let raw = tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;

    let mut messages = Vec::new();
    let mut has_cwd = false;
    let mut workspace_matches = false;

    for (index, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let Ok(record) = serde_json::from_str::<Value>(trimmed) else { continue; };

        let record_type = record.get("type").and_then(Value::as_str).unwrap_or_default().trim();
        let role = match record_type {
            "assistant" => "assistant",
            "user" => "user",
            _ => continue,
        };

        if let Some(cwd) = extract_history_cwd(&record) {
            has_cwd = true;
            if workspace_path_matches(expected_workspace_path, &cwd) {
                workspace_matches = true;
            }
        }

        let Some(content) = extract_history_content(&record, record_type) else { continue; };
        let timestamp = extract_history_timestamp(&record).unwrap_or_else(|| Utc::now().to_rfc3339());
        let id = record.get("uuid").and_then(Value::as_str)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{}-{}", session_id, index));

        messages.push(QwenHistoryMessage { id, role: role.to_string(), content, timestamp });
    }

    if has_cwd && !workspace_matches {
        return Err(format!("Session {} does not belong to workspace {}", session_id, expected_workspace_path));
    }

    Ok(messages)
}
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "feat(backend): add parse_qwen_history_messages function"
```

---

## Task 12: 重写 history.rs - Tauri 命令

**Files:**
- Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 实现 list_qwen_history_sessions 命令**

```rust
#[tauri::command]
pub async fn list_qwen_history_sessions(workspace_path: String) -> Result<Vec<QwenHistorySession>, String> {
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    let mut seen_sessions = HashSet::new();
    let mut sessions = Vec::new();

    for project_dir in candidate_dirs {
        let chats_dir = project_dir.join("chats");
        let Ok(mut reader) = tokio::fs::read_dir(&chats_dir).await else { continue };

        while let Ok(Some(entry)) = reader.next_entry().await {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".jsonl") { continue; }

            let session_id = file_name.trim_end_matches(".jsonl").to_string();
            if !seen_sessions.insert(session_id.clone()) { continue; }

            if let Ok(Some(summary)) = parse_qwen_history_summary(&entry.path(), &session_id, &normalized_workspace).await {
                sessions.push(summary);
            }
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}
```

- [ ] **Step 2: 实现 load_qwen_history_messages 命令**

```rust
#[tauri::command]
pub async fn load_qwen_history_messages(workspace_path: String, session_id: String) -> Result<Vec<QwenHistoryMessage>, String> {
    let normalized_session_id = session_id.trim().trim_end_matches(".jsonl").to_string();
    if normalized_session_id.is_empty() { return Err("session_id cannot be empty".to_string()); }

    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for project_dir in candidate_dirs {
        let file_path = project_dir.join("chats").join(format!("{}.jsonl", normalized_session_id));
        if file_path.exists() {
            return parse_qwen_history_messages(&file_path, &normalized_session_id, &normalized_workspace).await;
        }
    }

    Err(format!("Session {} not found", normalized_session_id))
}
```

- [ ] **Step 3: 实现 delete 和 clear 命令**

```rust
#[tauri::command]
pub async fn delete_qwen_history_session(workspace_path: String, session_id: String) -> Result<bool, String> {
    let normalized_session_id = session_id.trim().trim_end_matches(".jsonl").to_string();
    let normalized_workspace = normalize_workspace_path(&workspace_path);
    let candidate_dirs = qwen_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for project_dir in candidate_dirs {
        let file_path = project_dir.join("chats").join(format!("{}.jsonl", normalized_session_id));
        if tokio::fs::remove_file(&file_path).await.is_ok() { return Ok(true); }
    }
    Ok(false)
}

#[tauri::command]
pub async fn clear_qwen_history_sessions(workspace_path: String) -> Result<usize, String> {
    let normalized_workspace = normalize_workspace_path(&workspace_path);
    let candidate_dirs = qwen_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;
    let mut deleted = 0;

    for project_dir in candidate_dirs {
        let chats_dir = project_dir.join("chats");
        let Ok(mut reader) = tokio::fs::read_dir(&chats_dir).await else { continue };
        while let Ok(Some(entry)) = reader.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".jsonl") {
                if tokio::fs::remove_file(entry.path()).await.is_ok() { deleted += 1; }
            }
        }
    }
    Ok(deleted)
}
```

- [ ] **Step 4: 添加单元测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_workspace_path_matches() {
        assert!(workspace_path_matches("/Users/test/project", "/Users/test/project"));
        assert!(workspace_path_matches("/Users/test", "/Users/test/project"));
    }

    #[test]
    fn test_extract_text_from_parts() {
        let parts = json!([
            {"text": "思考", "thought": true},
            {"text": "回复内容"},
            {"functionCall": {"name": "test"}}
        ]);
        assert_eq!(extract_text_from_parts(&parts), Some("回复内容".to_string()));
    }
}
```

- [ ] **Step 3: 验证编译和测试**

Run: `cd src-tauri && cargo test`
Expected: 测试通过

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "refactor(backend): complete history.rs with Tauri commands"
```

---

## Task 13: 重写 qwen_adapter.rs - 删除 WebSocket 代码

**Files:**
- Modify: `src-tauri/src/agents/qwen_adapter.rs`

- [ ] **Step 1: 删除 find_available_port 函数**

删除整个函数：
```rust
// 删除这个函数
pub async fn find_available_port() -> Result<u16, String> { ... }
```

- [ ] **Step 2: 删除 WebSocket 重试循环逻辑**

删除 `message_listener_task` 中的 WebSocket 连接重试逻辑（`retry_count`, `max_retries`, while 循环等）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agents/qwen_adapter.rs
git commit -m "refactor(backend): remove WebSocket retry logic from qwen_adapter"
```

---

## Task 14: 重写 qwen_adapter.rs - stdio AcpConnection

**Files:**
- Modify: `src-tauri/src/agents/qwen_adapter.rs`

- [ ] **Step 1: 添加 stdio 导入**

```rust
use std::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{timeout, Duration};
```

- [ ] **Step 2: 删除 WebSocket 导入**

删除：
```rust
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::MaybeTlsStream;
```

- [ ] **Step 3: 实现 stdio AcpConnection 结构**

```rust
struct AcpConnection {
    stdin: tokio::process::ChildStdin,
    stdout_lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

impl AcpConnection {
    fn new(stdin: tokio::process::ChildStdin, stdout: tokio::process::ChildStdout) -> Self {
        Self {
            stdin,
            stdout_lines: BufReader::new(stdout).lines(),
        }
    }

    async fn send(&mut self, msg: String) -> Result<(), String> {
        self.stdin.write_all(msg.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn recv(&mut self) -> Result<Option<String>, String> {
        match timeout(Duration::from_secs(120), self.stdout_lines.next_line()).await {
            Ok(Ok(Some(line))) => Ok(Some(line)),
            Ok(Ok(None)) => Ok(None),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Ok(None),
        }
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agents/qwen_adapter.rs
git commit -m "refactor(backend): add stdio AcpConnection struct"
```

---

## Task 15: 重写 qwen_adapter.rs - 修改 message_listener_task 签名

**Files:**
- Modify: `src-tauri/src/agents/qwen_adapter.rs`

- [ ] **Step 1: 修改函数签名**

```rust
pub async fn message_listener_task(
    app_handle: tauri::AppHandle,
    agent_id: String,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    workspace_path: String,
    mut message_rx: UnboundedReceiver<ListenerCommand>,
) {
```

- [ ] **Step 2: 转换 stdio 为 async 并消费 stderr**

```rust
    // 转换为 async 类型
    let stdin = tokio::process::ChildStdin::from_std(stdin).expect("Failed to convert stdin");
    let stdout = tokio::process::ChildStdout::from_std(stdout).expect("Failed to convert stdout");
    let stderr = tokio::process::ChildStderr::from_std(stderr).expect("Failed to convert stderr");

    // 异步消费 stderr，避免缓冲区阻塞
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for line in String::from_utf8_lossy(&buf[..n]).lines() {
                        eprintln!("[qwen stderr] {}", line);
                    }
                }
            }
        }
    });

    let mut conn = AcpConnection::new(stdin, stdout);
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/agents/qwen_adapter.rs
git commit -m "refactor(backend): update message_listener_task signature for stdio"
```

---

## Task 16: 重写 qwen_adapter.rs - 删除 _iflow 私有方法

**Files:**
- Modify: `src-tauri/src/agents/qwen_adapter.rs`

- [ ] **Step 1: 删除 _iflow/user/questions handler**

在 `handle_server_request` 函数中删除：
```rust
// 删除这个分支
"_iflow/user/questions" => {
    send_rpc_result(conn, request_id, json!({ "answers": {} })).await
}
```

- [ ] **Step 2: 删除 _iflow/plan/exit handler**

在 `handle_server_request` 函数中删除：
```rust
// 删除这个分支
"_iflow/plan/exit" => send_rpc_result(conn, request_id, json!({ "approved": true })).await,
```

- [ ] **Step 3: 添加 terminal 类请求处理**

对于 `terminal/*` 请求，返回 method not found：
```rust
// 在 handle_server_request 中添加
"terminal/create" | "terminal/output" | "terminal/kill" | "terminal/release" | "terminal/wait_for_exit" => {
    send_rpc_error(conn, request_id, -32601, "Terminal operations not supported").await
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/agents/qwen_adapter.rs
git commit -m "refactor(backend): remove _iflow handlers, add terminal method not found"
```

---

## Task 17: 更新前端 tauri.ts

**Files:**
- Rewrite: `src/services/tauri.ts`

- [ ] **Step 1: 重命名所有函数**

```typescript
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import type {
  QwenHistorySessionRecord,
  QwenHistoryMessageRecord,
  ModelOption,
  SkillRuntimeItem,
  StorageSnapshot,
  GitFileChange,
} from '../types';

export { convertFileSrc, getVersion };

export interface ConnectQwenResult {
  success: boolean;
  error?: string;
}

export function connectQwen(
  agentId: string, qwenPath: string, workspacePath: string, model: string | null
): Promise<ConnectQwenResult> {
  return invoke('connect_qwen', { agentId, qwenPath, workspacePath, model });
}

export function listQwenHistorySessions(workspacePath: string): Promise<QwenHistorySessionRecord[]> {
  return invoke('list_qwen_history_sessions', { workspacePath });
}

export function loadQwenHistoryMessages(workspacePath: string, sessionId: string): Promise<QwenHistoryMessageRecord[]> {
  return invoke('load_qwen_history_messages', { workspacePath, sessionId });
}

export function deleteQwenHistorySession(workspacePath: string, sessionId: string): Promise<boolean> {
  return invoke('delete_qwen_history_session', { workspacePath, sessionId });
}

export function clearQwenHistorySessions(workspacePath: string): Promise<number> {
  return invoke('clear_qwen_history_sessions', { workspacePath });
}

export function listAvailableModels(qwenPath: string): Promise<ModelOption[]> {
  return invoke('list_available_models', { qwenPath });
}

// 其他函数保持不变（disconnectAgent, sendMessage, stopMessage 等）
```

- [ ] **Step 2: Commit**

```bash
git add src/services/tauri.ts
git commit -m "refactor(frontend): rename tauri.ts functions for Qwen"
```

---

## Task 18: 更新前端 types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 修改类型定义**

```typescript
export interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  qwenPath?: string;  // iflowPath -> qwenPath
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
  source?: 'local' | 'qwen-log';  // iflow-log -> qwen-log
  messageCountHint?: number;
}

export interface SkillRuntimeItem {
  agentType: string;
  skillName: string;
  title: string;
  description: string;
  path: string;
  source: 'qwen-cli-dir';
  discoveredAt: number;
}

export interface QwenHistorySessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface QwenHistoryMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "refactor(frontend): rename types for Qwen"
```

---

## Task 19: 更新前端 actions.ts 和数据归一化

**Files:**
- Modify: `src/features/agents/actions.ts`
- Modify: `src/features/storage/index.ts`

- [ ] **Step 1: 更新 actions.ts 默认值**

```typescript
import { connectQwen, disconnectAgent } from '../../services/tauri';

export async function addAgent(name: string, qwenPath: string, workspacePath: string) {
  showLoading('正在连接 Qwen...');
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
  // ...
  showSuccess('Qwen 连接成功！');
}
```

- [ ] **Step 2: 添加旧数据归一化逻辑**

修改 `loadAgents` 函数：

```typescript
state.agents = state.agents.map((agent) => ({
  ...agent,
  // 归一化旧数据
  type: agent.type === 'iflow' ? 'qwen' : agent.type,
  qwenPath: agent.qwenPath || agent.iflowPath || 'qwen',
  thinkEnabled: Boolean(agent.thinkEnabled),
  status: 'disconnected' as const,
}));

// 删除旧字段
for (const agent of state.agents) {
  delete (agent as any).iflowPath;
  delete (agent as any).port;
}
```

- [ ] **Step 3: 更新 storage 归一化**

修改 `src/features/storage/index.ts`，在加载时归一化 `source` 字段：

```typescript
for (const session of sessions) {
  if (session.source === 'iflow-log') {
    session.source = 'qwen-log';
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/features/agents/actions.ts src/features/storage/index.ts
git commit -m "refactor(frontend): update actions.ts with data normalization"
```

---

## Task 20: 更新前端其他文件

**Files:**
- Modify: `src/features/agents/reconnect.ts`
- Modify: `src/features/agents/model.ts`
- Modify: `src/features/sessions/index.ts`

- [ ] **Step 1: 更新函数调用**

- `reconnect.ts`: `connectQwen(agent.qwenPath || 'qwen', ...)`
- `model.ts`: `listAvailableModels`, `switchAgentModel`
- `sessions/index.ts`: `listQwenHistorySessions`, `loadQwenHistoryMessages`, `syncQwenHistorySessions`

- [ ] **Step 2: Commit**

```bash
git add src/features/
git commit -m "refactor(frontend): update remaining frontend files for Qwen"
```

---

## Task 21: 更新 index.html

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 更新主题 key 和文案**

- `iflow-theme` → `qwen-theme`
- "添加 iFlow Agent" → "添加 Qwen Agent"
- "iFlow CLI 路径" → "Qwen CLI 路径"
- Agent icon: `iF` → `Qw`

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "refactor(frontend): update index.html for Qwen"
```

---

## Task 22: 验证

- [ ] **Step 1: 运行 Rust 测试**

Run: `cd src-tauri && cargo test`

- [ ] **Step 2: 运行前端测试**

Run: `npm test`

- [ ] **Step 3: 构建验证**

Run: `npm run tauri:build`

- [ ] **Step 4: 手工验证 - 启动开发服务器**

Run: `npm run tauri:dev`

- [ ] **Step 5: 手工验证 - 连接 Qwen**

- 点击"添加 Agent"按钮
- 输入名称和 Qwen CLI 路径（默认 `qwen`）
- 选择工作区
- 验证连接成功

- [ ] **Step 6: 手工验证 - 发送消息**

- 输入消息并发送
- 验证收到回复

- [ ] **Step 7: 手工验证 - 历史会话**

- 刷新页面
- 验证历史会话列表正确显示
- 点击历史会话，验证消息加载

- [ ] **Step 8: 手工验证 - 技能发现**

- 打开能力中心
- 验证技能列表正确显示

- [ ] **Step 9: 手工验证 - 模型切换**

- 切换模型
- 验证切换成功

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "test: verify all tests pass after Qwen migration"
```

---

## Summary

完成以上 22 个任务后，FlowHub 将完全从 iFlow 切换到 Qwen Code。

关键变更总结：
1. ✅ 移除 WebSocket 依赖（tokio-tungstenite, url）
2. ✅ stdio ACP 传输层实现
3. ✅ 删除 model_resolver.rs
4. ✅ Qwen JSONL 历史解析
5. ✅ 所有 iflow 命名改为 qwen
6. ✅ 旧数据归一化逻辑
7. ✅ 删除 `_iflow/*` 私有方法 handler
8. ✅ Terminal 类请求返回 method not found
9. ✅ 存储 key 首阶段保持不变（iflow-*）

