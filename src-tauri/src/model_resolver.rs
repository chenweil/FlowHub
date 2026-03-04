//! iFlow 可执行文件路径解析与模型列表提取
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::models::ModelOption;
use crate::runtime_env::resolve_executable_path;

fn resolve_iflow_executable_path(iflow_path: &str) -> Result<PathBuf, String> {
    resolve_executable_path(iflow_path)
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

fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

fn unescape_js_string(raw: &str) -> String {
    let mut output = String::with_capacity(raw.len());
    let mut chars = raw.chars();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }

        match chars.next() {
            Some('"') => output.push('"'),
            Some('\'') => output.push('\''),
            Some('\\') => output.push('\\'),
            Some('n') => output.push('\n'),
            Some('r') => output.push('\r'),
            Some('t') => output.push('\t'),
            Some(other) => output.push(other),
            None => break,
        }
    }

    output
}

fn parse_quoted_js_string(source: &str, index: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    if index >= bytes.len() {
        return None;
    }

    let quote = bytes[index];
    if quote != b'"' && quote != b'\'' {
        return None;
    }

    let mut cursor = index + 1;
    let start = cursor;
    let mut escaped = false;

    while cursor < bytes.len() {
        let current = bytes[cursor];
        if escaped {
            escaped = false;
            cursor += 1;
            continue;
        }

        if current == b'\\' {
            escaped = true;
            cursor += 1;
            continue;
        }

        if current == quote {
            let raw = &source[start..cursor];
            return Some((unescape_js_string(raw), cursor + 1));
        }

        cursor += 1;
    }

    None
}

fn parse_keyed_js_string(source: &str, index: usize, key: &str) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut cursor = skip_ascii_whitespace(bytes, index);
    if !source[cursor..].starts_with(key) {
        return None;
    }

    cursor += key.len();
    cursor = skip_ascii_whitespace(bytes, cursor);
    if cursor >= bytes.len() || bytes[cursor] != b':' {
        return None;
    }

    cursor += 1;
    cursor = skip_ascii_whitespace(bytes, cursor);
    parse_quoted_js_string(source, cursor)
}

fn is_likely_model_value(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_ascii_whitespace()) {
        return false;
    }

    trimmed.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+')
    })
}

fn dedupe_model_options(options: Vec<ModelOption>) -> Vec<ModelOption> {
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();

    for option in options {
        let value = option.value.trim();
        if value.is_empty() {
            continue;
        }

        let key = value.to_ascii_lowercase();
        if seen.insert(key) {
            deduped.push(option);
        }
    }

    deduped
}

fn parse_model_entries_from_text(source: &str) -> Vec<ModelOption> {
    let bytes = source.as_bytes();
    let mut options = Vec::new();
    let mut cursor = 0_usize;

    while let Some(rel) = source[cursor..].find("label") {
        let start = cursor + rel;
        if let Some((label, after_label)) = parse_keyed_js_string(source, start, "label") {
            let mut next = skip_ascii_whitespace(bytes, after_label);
            if next < bytes.len() && bytes[next] == b',' {
                next += 1;
            }
            if let Some((value, after_value)) = parse_keyed_js_string(source, next, "value") {
                if is_likely_model_value(&value) {
                    options.push(ModelOption { label, value });
                }
                cursor = after_value;
                continue;
            }
        }
        cursor = start + "label".len();
    }

    cursor = 0;
    while let Some(rel) = source[cursor..].find("value") {
        let start = cursor + rel;
        if let Some((value, after_value)) = parse_keyed_js_string(source, start, "value") {
            let mut next = skip_ascii_whitespace(bytes, after_value);
            if next < bytes.len() && bytes[next] == b',' {
                next += 1;
            }
            if let Some((label, after_label)) = parse_keyed_js_string(source, next, "label") {
                if is_likely_model_value(&value) {
                    options.push(ModelOption { label, value });
                }
                cursor = after_label;
                continue;
            }
        }
        cursor = start + "value".len();
    }

    dedupe_model_options(options)
}

fn parse_model_entries_from_array_block(block: &str) -> Vec<ModelOption> {
    parse_model_entries_from_text(block)
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

    let models = if let Some(block) = block {
        parse_model_entries_from_array_block(&block)
    } else {
        Vec::new()
    };

    let models = if models.is_empty() {
        parse_model_entries_from_text(&bundle_text)
    } else {
        models
    };

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
        parse_model_entries_from_text,
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
    fn parse_model_entries_from_text_without_anchor() {
        let source = r#"abc { label : "GLM-5" , value : "glm-5" } xyz {value:'deepseek-v3.2-chat', label:'DeepSeek-V3.2'}"#;
        let entries = parse_model_entries_from_text(source);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].label, "GLM-5");
        assert_eq!(entries[0].value, "glm-5");
        assert_eq!(entries[1].label, "DeepSeek-V3.2");
        assert_eq!(entries[1].value, "deepseek-v3.2-chat");
    }

    #[test]
    fn build_bundle_candidates_prefers_iflow_js() {
        let candidates = build_bundle_entry_candidates(Path::new("/tmp/bundle/entry.js"));
        assert_eq!(candidates[0], Path::new("/tmp/bundle/iflow.js"));
        assert_eq!(candidates[1], Path::new("/tmp/bundle/entry.js"));
    }
}
