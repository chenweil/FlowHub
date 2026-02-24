// iFlow Workspace - Tauri Backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod commands;
mod manager;
mod models;
mod router;
mod state;
mod storage;

use commands::{connect_iflow, disconnect_agent, send_message};
use state::AppState;
use storage::{load_storage_snapshot, save_storage_snapshot};

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_iflow,
            send_message,
            disconnect_agent,
            load_storage_snapshot,
            save_storage_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
