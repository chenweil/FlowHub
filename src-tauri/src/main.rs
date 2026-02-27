// iFlow Workspace - Tauri Backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod artifact;
mod commands;
mod history;
mod manager;
mod model_resolver;
mod models;
mod router;
mod state;
mod storage;

use artifact::{read_html_artifact, resolve_html_artifact_path};
use commands::{
    connect_iflow, disconnect_agent, send_message, stop_message, switch_agent_model,
};
use model_resolver::list_available_models;
use history::{
    clear_iflow_history_sessions, delete_iflow_history_session, list_iflow_history_sessions,
    load_iflow_history_messages,
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
            delete_iflow_history_session,
            clear_iflow_history_sessions,
            resolve_html_artifact_path,
            read_html_artifact,
            disconnect_agent,
            load_storage_snapshot,
            save_storage_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
