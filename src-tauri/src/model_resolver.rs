//! iFlow 可执行文件路径解析与模型列表提取
use std::env;
use std::path::{Path, PathBuf};

use crate::models::ModelOption;

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
