use std::path::PathBuf;

#[tauri::command]
pub async fn pick_folder(default_path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();

    if let Some(path) = default_path.map(|value| value.trim().to_string()) {
        if !path.is_empty() {
            let normalized = PathBuf::from(path);
            if normalized.exists() {
                dialog = dialog.set_directory(normalized);
            }
        }
    }

    let picked = dialog.pick_folder().await;
    Ok(picked.map(|handle| handle.path().to_string_lossy().to_string()))
}
