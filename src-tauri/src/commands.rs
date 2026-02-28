use std::process::Stdio;

use tauri::State;
use tokio::process::{Child, Command};
use tokio::time::{timeout, Duration};

use crate::agents::iflow_adapter::{find_available_port, message_listener_task};
use crate::models::{AgentInfo, AgentStatus, ConnectResponse, ListenerCommand};
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
