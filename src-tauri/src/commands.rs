use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::State;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::agents::iflow_adapter::{find_available_port, message_listener_task};
use crate::models::{AgentInfo, AgentStatus, ConnectResponse, ListenerCommand, ModelOption};
use crate::state::{AgentInstance, AppState};

async fn spawn_iflow_agent(
    app_handle: tauri::AppHandle,
    state: &AppState,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    println!("Connecting to iFlow...");
    println!("Agent ID: {}", agent_id);
    println!("Workspace: {}", workspace_path);
    if let Some(model_name) = model.as_ref() {
        println!("Model override: {}", model_name);
    }

    // 查找可用端口
    let port = find_available_port().await?;
    println!("Using port: {}", port);

    // 启动 iFlow 进程
    let mut cmd = Command::new(&iflow_path);
    cmd.current_dir(&workspace_path)
        .arg("--experimental-acp")
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(model_name) = model.as_ref() {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cmd.arg("--model").arg(trimmed);
        }
    }

    println!("Spawning iFlow process...");
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start iFlow: {}", e))?;
    println!("iFlow process started, PID: {:?}", child.id());

    // 等待 iFlow 启动
    println!("Waiting for iFlow to initialize...");
    tokio::time::sleep(Duration::from_secs(3)).await;

    let ws_url = format!("ws://127.0.0.1:{}/acp", port);

    // 创建消息发送通道
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ListenerCommand>();

    // 保存 Agent 实例
    let agent_info = AgentInfo {
        id: agent_id.clone(),
        name: "iFlow".to_string(),
        agent_type: "iflow".to_string(),
        status: AgentStatus::Connected,
        workspace_path: workspace_path.clone(),
        port: Some(port),
    };

    let instance = AgentInstance {
        info: agent_info,
        process: Some(child),
        port,
        iflow_path: iflow_path.clone(),
        model: model.clone(),
        message_sender: Some(tx),
    };

    state.agent_manager.upsert(agent_id.clone(), instance).await;
    let (agent_count, agent_ids) = state.agent_manager.stats().await;
    println!("[connect] Agent saved, total agents: {}", agent_count);
    println!("[connect] Agent IDs: {:?}", agent_ids);

    // 启动后台消息监听任务
    let app_handle_clone = app_handle.clone();
    let agent_id_clone = agent_id.clone();
    let ws_url_clone = ws_url.clone();
    let workspace_path_clone = workspace_path.clone();

    tokio::spawn(async move {
        message_listener_task(
            app_handle_clone,
            agent_id_clone,
            ws_url_clone,
            workspace_path_clone,
            rx,
        )
        .await;
    });

    println!("Agent {} connected successfully", agent_id);

    Ok(ConnectResponse {
        success: true,
        port,
        error: None,
    })
}

/// 连接 iFlow
#[tauri::command]
pub async fn connect_iflow(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    spawn_iflow_agent(
        app_handle,
        &state,
        agent_id,
        iflow_path,
        workspace_path,
        model,
    )
    .await
}

/// 切换模型（通过重启 ACP 会话生效）
#[tauri::command]
pub async fn switch_agent_model(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: String,
) -> Result<ConnectResponse, String> {
    let target_model = model.trim();
    if target_model.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }

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
                    Ok(Ok(Ok(_current_model))) => {
                        let port = state
                            .agent_manager
                            .port_of(&agent_id)
                            .await
                            .ok_or_else(|| "Agent port not available".to_string())?;
                        return Ok(ConnectResponse {
                            success: true,
                            port,
                            error: None,
                        });
                    }
                    Ok(Ok(Err(err))) => {
                        println!(
                            "[switch_agent_model] ACP switch failed, fallback to restart: {}",
                            err
                        );
                    }
                    Ok(Err(_)) => {
                        println!(
                            "[switch_agent_model] ACP switch response channel closed, fallback to restart"
                        );
                    }
                    Err(_) => {
                        println!("[switch_agent_model] ACP switch timeout, fallback to restart");
                    }
                }
            } else {
                println!(
                    "[switch_agent_model] Failed to send ACP switch command, fallback to restart"
                );
            }
        }
    }

    if let Some(mut instance) = state.agent_manager.remove(&agent_id).await {
        if let Some(mut process) = instance.process.take() {
            let _ = process.kill().await;
        }
    }

    spawn_iflow_agent(
        app_handle,
        &state,
        agent_id,
        iflow_path,
        workspace_path,
        Some(target_model.to_string()),
    )
    .await
}

fn resolve_iflow_executable_path(iflow_path: &str) -> Result<PathBuf, String> {
    let trimmed = iflow_path.trim();
    if trimmed.is_empty() {
        return Err("iflow path cannot be empty".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    if input_path.is_absolute() || trimmed.contains(std::path::MAIN_SEPARATOR) {
        if input_path.exists() {
            let resolved = std::fs::canonicalize(&input_path).unwrap_or(input_path);
            return Ok(resolved);
        }
        return Err(format!("iflow executable not found: {}", trimmed));
    }

    let path_var =
        env::var_os("PATH").ok_or_else(|| "PATH environment variable not found".to_string())?;
    for search_path in env::split_paths(&path_var) {
        let candidate = search_path.join(trimmed);
        if candidate.is_file() {
            let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            return Ok(resolved);
        }
    }

    Err(format!("iflow executable not found in PATH: {}", trimmed))
}

fn resolve_iflow_bundle_entry(iflow_path: &str) -> Result<PathBuf, String> {
    let executable_path = resolve_iflow_executable_path(iflow_path)?;
    let resolved = std::fs::canonicalize(&executable_path).unwrap_or(executable_path);

    if resolved.extension().and_then(|ext| ext.to_str()) != Some("js") {
        return Err(format!(
            "Unsupported iflow executable target: {}",
            resolved.display()
        ));
    }

    let candidates = build_bundle_entry_candidates(&resolved);
    for candidate in candidates {
        if candidate.exists() {
            let canonicalized = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            return Ok(canonicalized);
        }
    }

    Err(format!(
        "iflow bundle entry not found near: {}",
        resolved.display()
    ))
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

fn build_bundle_entry_candidates(executable_entry: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(parent) = executable_entry.parent() {
        // Newer iFlow releases put model constants in iflow.js instead of entry.js.
        push_candidate(&mut candidates, parent.join("iflow.js"));
        push_candidate(&mut candidates, parent.join("entry.js"));
    }

    push_candidate(&mut candidates, executable_entry.to_path_buf());
    candidates
}

fn extract_bracket_block(source: &str, anchor: &str) -> Option<String> {
    let start_anchor = source.find(anchor)?;
    let array_start = start_anchor + anchor.len().saturating_sub(1);
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, ch) in source[array_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == '"' {
            in_string = !in_string;
            continue;
        }

        if in_string {
            continue;
        }

        if ch == '[' {
            depth += 1;
            continue;
        }

        if ch == ']' {
            depth -= 1;
            if depth == 0 {
                let end_index = array_start + offset + 1;
                return Some(source[array_start..end_index].to_string());
            }
        }
    }

    None
}

fn parse_model_entries_from_array_block(block: &str) -> Vec<ModelOption> {
    let mut options = Vec::new();
    let mut cursor = 0_usize;
    const LABEL_PREFIX: &str = "{label:\"";
    const VALUE_SEPARATOR: &str = "\",value:\"";

    while let Some(start_rel) = block[cursor..].find(LABEL_PREFIX) {
        let label_start = cursor + start_rel + LABEL_PREFIX.len();
        let Some(value_sep_rel) = block[label_start..].find(VALUE_SEPARATOR) else {
            break;
        };
        let label_end = label_start + value_sep_rel;
        let value_start = label_end + VALUE_SEPARATOR.len();
        let Some(value_end_rel) = block[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + value_end_rel;

        let label = block[label_start..label_end].replace("\\\"", "\"");
        let value = block[value_start..value_end].replace("\\\"", "\"");
        if !value.trim().is_empty() {
            options.push(ModelOption { label, value });
        }

        cursor = value_end + 1;
    }

    options
}

fn extract_model_options_from_bundle(entry_path: &Path) -> Result<Vec<ModelOption>, String> {
    let bundle_text = std::fs::read_to_string(entry_path).map_err(|e| {
        format!(
            "Failed to read iflow bundle {}: {}",
            entry_path.display(),
            e
        )
    })?;

    let anchors = ["CAe=[", "modelOptions=[", "models=["];
    let mut block = None;
    for anchor in anchors {
        block = extract_bracket_block(&bundle_text, anchor);
        if block.is_some() {
            break;
        }
    }

    let block = block.ok_or_else(|| "Failed to locate model list in iflow bundle".to_string())?;
    let models = parse_model_entries_from_array_block(&block);
    if models.is_empty() {
        return Err("No model entries found in iflow bundle".to_string());
    }

    Ok(models)
}

#[tauri::command]
pub async fn list_available_models(iflow_path: String) -> Result<Vec<ModelOption>, String> {
    let entry_path = resolve_iflow_bundle_entry(&iflow_path)?;
    extract_model_options_from_bundle(&entry_path)
}

/// 发送消息
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    agent_id: String,
    content: String,
) -> Result<(), String> {
    println!(
        "[send_message] Starting for agent {}: {}",
        agent_id, content
    );

    let (agent_count, agent_ids) = state.agent_manager.stats().await;
    println!(
        "[send_message] Got agent manager snapshot, total agents: {}",
        agent_count
    );
    println!("[send_message] Available agent IDs: {:?}", agent_ids);
    println!("[send_message] Looking for agent: {}", agent_id);

    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if !agent_exists {
        println!("[send_message] ERROR: Agent {} not found!", agent_id);
        return Err(format!("Agent {} not found", agent_id));
    }
    println!(
        "[send_message] Found agent! sender exists: {}",
        sender.is_some()
    );

    if let Some(sender) = sender {
        println!(
            "[send_message] Queueing user prompt to listener: {}",
            &content[..content.len().min(100)]
        );
        match sender.send(ListenerCommand::UserPrompt(content)) {
            Ok(_) => {
                println!("[send_message] Prompt queued successfully");
                Ok(())
            }
            Err(e) => {
                println!("[send_message] Failed to queue prompt: {}", e);
                Err(format!("Failed to queue prompt: {}", e))
            }
        }
    } else {
        println!("[send_message] Message sender not available");
        Err("Message sender not available".to_string())
    }
}

/// 停止当前消息生成
#[tauri::command]
pub async fn stop_message(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if !agent_exists {
        return Err(format!("Agent {} not found", agent_id));
    }

    if let Some(sender) = sender {
        sender
            .send(ListenerCommand::CancelPrompt)
            .map_err(|e| format!("Failed to queue cancel request: {}", e))?;
        Ok(())
    } else {
        Err("Message sender not available".to_string())
    }
}

/// 断开连接
#[tauri::command]
pub async fn disconnect_agent(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    println!("Disconnecting agent: {}", agent_id);

    if let Some(mut instance) = state.agent_manager.remove(&agent_id).await {
        if let Some(mut process) = instance.process.take() {
            let _ = process.kill().await;
        }
        println!("Agent {} disconnected", agent_id);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        build_bundle_entry_candidates, extract_bracket_block, parse_model_entries_from_array_block,
    };

    #[test]
    fn extract_model_block_from_bundle() {
        let bundle = "abc CAe=[{label:\"GLM-4.7\",value:\"glm-4.7\"}] xyz";
        let block = extract_bracket_block(bundle, "CAe=[").unwrap_or_default();
        assert_eq!(block, "[{label:\"GLM-4.7\",value:\"glm-4.7\"}]");
    }

    #[test]
    fn parse_model_entries_from_block() {
        let block =
            r#"[{label:"GLM-4.7",value:"glm-4.7"},{label:"Kimi-K2.5",value:"kimi-k2.5"}]"#;
        let entries = parse_model_entries_from_array_block(block);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].label, "GLM-4.7");
        assert_eq!(entries[0].value, "glm-4.7");
        assert_eq!(entries[1].label, "Kimi-K2.5");
        assert_eq!(entries[1].value, "kimi-k2.5");
    }

    #[test]
    fn build_bundle_candidates_prefers_iflow_js() {
        let candidates = build_bundle_entry_candidates(Path::new("/tmp/bundle/entry.js"));
        assert_eq!(candidates[0], Path::new("/tmp/bundle/iflow.js"));
        assert_eq!(candidates[1], Path::new("/tmp/bundle/entry.js"));
    }
}
