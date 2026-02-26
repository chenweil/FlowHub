// iFlow Workspace - Tauri Backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod commands;
mod manager;
mod models;
mod router;
mod state;
mod storage;

use commands::{
    connect_iflow, disconnect_agent, list_available_models, list_iflow_history_sessions,
    load_iflow_history_messages, read_html_artifact, resolve_html_artifact_path, send_message, stop_message,
    switch_agent_model,
};
use state::AppState;
use storage::{load_storage_snapshot, save_storage_snapshot};

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_iflow,
            send_message,
            stop_message,
            switch_agent_model,
            list_available_models,
            list_iflow_history_sessions,
            load_iflow_history_messages,
            resolve_html_artifact_path,
            read_html_artifact,
            disconnect_agent,
            load_storage_snapshot,
            save_storage_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
