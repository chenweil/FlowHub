use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::State;
use tokio::process::{Child, Command};
use tokio::time::{timeout, Duration};

use crate::agents::iflow_adapter::{find_available_port, message_listener_task};
use crate::models::{AgentInfo, AgentStatus, ConnectResponse, ListenerCommand, SkillRuntimeItem};
use crate::runtime_env::{resolve_executable_path, runtime_path_env};
use crate::state::{AgentInstance, AppState};

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

    let resolved_iflow_path = resolve_executable_path(&iflow_path)?;
    let runtime_path = runtime_path_env()?;
    println!("Resolved iFlow executable: {}", resolved_iflow_path.display());

    // 启动 iFlow 进程
    let mut cmd = Command::new(&resolved_iflow_path);
    cmd.current_dir(&workspace_path)
        .arg("--experimental-acp")
        .arg("--port")
        .arg(port.to_string())
        .env("PATH", runtime_path)
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
        terminate_agent_instance(&mut instance).await;
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

#[tauri::command]
pub async fn toggle_agent_think(
    state: State<'_, AppState>,
    agent_id: String,
    enable: bool,
    config: Option<String>,
) -> Result<(), String> {
    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if !agent_exists {
        return Err(format!("Agent {} not found", agent_id));
    }

    let Some(sender) = sender else {
        return Err("Message sender not available".to_string());
    };

    let normalized_config = config
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "think".to_string());

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<bool, String>>();
    sender
        .send(ListenerCommand::SetThink {
            enable,
            config: normalized_config,
            response: tx,
        })
        .map_err(|e| format!("Failed to queue think switch: {}", e))?;

    match timeout(Duration::from_secs(20), rx).await {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err("Think switch response channel closed".to_string()),
        Err(_) => Err("Think switch timeout after 20 seconds".to_string()),
    }
}


/// 发送消息
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    agent_id: String,
    content: String,
    session_id: Option<String>,
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
        match sender.send(ListenerCommand::UserPrompt {
            content,
            session_id,
        }) {
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
        terminate_agent_instance(&mut instance).await;
        println!("Agent {} disconnected", agent_id);
    }

    Ok(())
}

fn normalize_lower_text(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn remove_wrapping_quotes(value: &str) -> String {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        return trimmed[1..trimmed.len() - 1].trim().to_string();
    }
    trimmed.to_string()
}

fn parse_skill_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut lines = content.lines();
    let first_line = lines.next().map(|line| line.trim()).unwrap_or_default();
    if first_line != "---" {
        return (None, None);
    }

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = normalize_lower_text(raw_key);
        let value = remove_wrapping_quotes(raw_value);
        if value.is_empty() {
            continue;
        }

        if key == "name" {
            name = Some(value);
            continue;
        }
        if key == "description" {
            description = Some(value);
        }
    }

    (name, description)
}

fn resolve_iflow_skill_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve home directory".to_string())?;
    Ok(home.join(".iflow").join("skills"))
}

fn read_iflow_skills_from_root(root: &Path) -> Result<Vec<SkillRuntimeItem>, String> {
    if !root.exists() {
        return Err(format!("技能目录不存在: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("技能路径不是目录: {}", root.display()));
    }

    let mut skills: Vec<SkillRuntimeItem> = Vec::new();
    let mut seen = HashSet::<String>::new();
    let mut dir_entries: Vec<_> = std::fs::read_dir(root)
        .map_err(|e| format!("读取技能目录失败: {}", e))?
        .filter_map(|entry| entry.ok())
        .collect();
    dir_entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());

    for entry in dir_entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md_path = path.join("SKILL.md");
        if !skill_md_path.is_file() {
            continue;
        }

        let content = match std::fs::read_to_string(&skill_md_path) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("Read SKILL.md failed ({}): {}", skill_md_path.display(), err);
                continue;
            }
        };

        let (manifest_name, manifest_description) = parse_skill_frontmatter(&content);
        let fallback_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let skill_name = manifest_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or(fallback_name);
        if skill_name.is_empty() {
            continue;
        }

        let dedupe_key = normalize_lower_text(&skill_name);
        if dedupe_key.is_empty() || seen.contains(&dedupe_key) {
            continue;
        }
        seen.insert(dedupe_key);

        skills.push(SkillRuntimeItem {
            agent_type: "iflow".to_string(),
            skill_name: skill_name.clone(),
            title: skill_name,
            description: manifest_description.unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            source: "iflow-cli-dir".to_string(),
            discovered_at: chrono::Utc::now().timestamp_millis(),
        });
    }

    Ok(skills)
}

#[tauri::command]
pub async fn discover_skills(agent_type: String) -> Result<Vec<SkillRuntimeItem>, String> {
    let normalized_agent_type = normalize_lower_text(&agent_type);
    if normalized_agent_type != "iflow" {
        return Ok(Vec::new());
    }

    let root = resolve_iflow_skill_root()?;
    read_iflow_skills_from_root(&root)
}

#[cfg(test)]
mod tests {
    use super::{parse_skill_frontmatter, read_iflow_skills_from_root};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir_name(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        format!("iflow-workspace-{}-{}", tag, nanos)
    }

    #[test]
    fn parse_skill_frontmatter_reads_name_and_description() {
        let content = r#"---
name: daily-plan
description: "Generate daily plan"
---
# body
"#;
        let (name, description) = parse_skill_frontmatter(content);
        assert_eq!(name.as_deref(), Some("daily-plan"));
        assert_eq!(description.as_deref(), Some("Generate daily plan"));
    }

    #[test]
    fn read_iflow_skills_dedupes_by_name_case_insensitive() {
        let temp_root = std::env::temp_dir().join(make_temp_dir_name("skills"));
        std::fs::create_dir_all(&temp_root).expect("create temp root");

        let first = temp_root.join("skill-a");
        let second = temp_root.join("skill-b");
        std::fs::create_dir_all(&first).expect("create first dir");
        std::fs::create_dir_all(&second).expect("create second dir");
        std::fs::write(
            first.join("SKILL.md"),
            "---\nname: Daily-Plan\ndescription: first\n---\n",
        )
        .expect("write first skill");
        std::fs::write(
            second.join("SKILL.md"),
            "---\nname: daily-plan\ndescription: second\n---\n",
        )
        .expect("write second skill");

        let skills = read_iflow_skills_from_root(&temp_root).expect("read skills");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].skill_name, "Daily-Plan");

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
