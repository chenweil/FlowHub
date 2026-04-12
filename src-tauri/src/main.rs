// iFlow Workspace - Tauri Backend
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
    connect_qwen, discover_skills, disconnect_agent, list_workspace_files, send_message,
    shutdown_all_agents, stop_message, switch_qwen_model, toggle_agent_think,
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
            switch_qwen_model,
            toggle_agent_think,
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
            list_workspace_files,
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
