use serde_json::{json, Value};
use tauri::Emitter;

use crate::models::{PlanEntry, ToolCall};

pub(crate) fn text_from_content(content: &Value) -> Option<String> {
    let content_type = content.get("type")?.as_str()?;
    match content_type {
        "text" => content.get("text")?.as_str().map(|s| s.to_string()),
        _ => Some(content.to_string()),
    }
}

pub(crate) fn text_from_tool_contents(contents: &Value) -> Option<String> {
    let items = contents.as_array()?;
    let mut texts = Vec::new();

    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("content") => {
                if let Some(content) = item.get("content") {
                    if let Some(text) = text_from_content(content) {
                        texts.push(text);
                    }
                }
            }
            Some("diff") => {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    texts.push(format!("[diff] {}", path));
                }
            }
            _ => {}
        }
    }

    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

fn stop_reason_to_message(reason: &str) -> &'static str {
    match reason {
        "end_turn" => "✅ 任务完成",
        "max_tokens" => "⚠️ 达到最大令牌限制",
        "cancelled" => "🚫 任务已取消",
        "refusal" => "⛔ 模型拒绝回答",
        _ => "✅ 任务结束",
    }
}

pub(crate) async fn emit_task_finish(app_handle: &tauri::AppHandle, agent_id: &str, reason: &str) {
    // end_turn 是最常见的正常结束，不再向聊天区追加冗余“任务完成”文案。
    if reason != "end_turn" {
        let _ = app_handle.emit(
            "stream-message",
            json!({
                "agentId": agent_id,
                "content": stop_reason_to_message(reason),
                "type": "system",
            }),
        );
    }

    let _ = app_handle.emit(
        "task-finish",
        json!({
            "agentId": agent_id,
            "reason": reason,
        }),
    );
}

pub(crate) async fn handle_session_update(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    update: &Value,
) {
    let Some(session_update) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return;
    };

    match session_update {
        "agent_message_chunk" => {
            if let Some(content) = update.get("content").and_then(text_from_content) {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": content,
                        "type": "content",
                    }),
                );
            }
        }
        "agent_thought_chunk" => {
            if let Some(content) = update.get("content").and_then(text_from_content) {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": format!("💭 {}", content),
                        "type": "thought",
                    }),
                );
            }
        }
        "tool_call" | "tool_call_update" => {
            let tool_call = ToolCall {
                id: update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: update
                    .get("toolName")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_string(),
                status: update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_string(),
                arguments: update.get("args").cloned(),
                output: update.get("content").and_then(text_from_tool_contents),
            };

            let _ = app_handle.emit(
                "tool-call",
                json!({
                    "agentId": agent_id,
                    "toolCalls": vec![tool_call],
                }),
            );
        }
        "plan" => {
            let mut entries = Vec::new();

            if let Some(raw_entries) = update.get("entries").and_then(Value::as_array) {
                for raw_entry in raw_entries {
                    if let Ok(entry) = serde_json::from_value::<PlanEntry>(raw_entry.clone()) {
                        entries.push(format!("[{}] {}", entry.status, entry.content));
                    }
                }
            }

            if !entries.is_empty() {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": format!("📋 执行计划:\n{}", entries.join("\n")),
                        "type": "plan",
                    }),
                );
            }
        }
        "user_message_chunk" => {
            // 用户消息回显忽略
        }
        _ => {
            println!(
                "[listener] Unhandled session update type: {}",
                session_update
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{text_from_content, text_from_tool_contents};

    #[test]
    fn test_text_from_content_text() {
        let content = json!({ "type": "text", "text": "hello" });
        assert_eq!(text_from_content(&content).as_deref(), Some("hello"));
    }

    #[test]
    fn test_text_from_tool_contents() {
        let content = json!([
            {
                "type": "content",
                "content": {
                    "type": "text",
                    "text": "line1"
                }
            },
            {
                "type": "diff",
                "path": "src/main.ts"
            }
        ]);

        let text = text_from_tool_contents(&content).unwrap_or_default();
        assert!(text.contains("line1"));
        assert!(text.contains("src/main.ts"));
    }
}
