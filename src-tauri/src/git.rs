use serde::Serialize;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub staged_status: String,
    pub unstaged_status: String,
}

fn status_code_to_label(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "unmerged",
        '?' => "untracked",
        '!' => "ignored",
        ' ' => "none",
        _ => "unknown",
    }
}

fn parse_status_line(line: &str) -> Option<GitFileChange> {
    if line.len() < 3 {
        return None;
    }

    let mut status_chars = line.chars();
    let staged_code = status_chars.next()?;
    let unstaged_code = status_chars.next()?;
    let path_segment = line.get(3..)?.trim();
    if path_segment.is_empty() {
        return None;
    }

    // 重命名输出通常是 "old/path -> new/path"，面板展示目标路径。
    let normalized_path = path_segment
        .rsplit_once(" -> ")
        .map(|(_, right)| right)
        .unwrap_or(path_segment)
        .trim()
        .trim_matches('"')
        .to_string();

    if normalized_path.is_empty() {
        return None;
    }

    Some(GitFileChange {
        path: normalized_path,
        staged_status: status_code_to_label(staged_code).to_string(),
        unstaged_status: status_code_to_label(unstaged_code).to_string(),
    })
}

async fn ensure_git_workspace(workspace_path: &str) -> Result<(), String> {
    let output = timeout(
        Duration::from_secs(8),
        Command::new("git")
            .arg("-C")
            .arg(workspace_path)
            .arg("rev-parse")
            .arg("--is-inside-work-tree")
            .output(),
    )
    .await
    .map_err(|_| "Git 命令超时，请稍后重试".to_string())?
    .map_err(|e| format!("执行 Git 失败: {}", e))?;

    if !output.status.success() {
        return Err("当前工作目录不是 Git 仓库，无法跟踪文件变更".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn list_git_changes(workspace_path: String) -> Result<Vec<GitFileChange>, String> {
    ensure_git_workspace(&workspace_path).await?;

    let output = timeout(
        Duration::from_secs(10),
        Command::new("git")
            .arg("-C")
            .arg(&workspace_path)
            .arg("status")
            .arg("--porcelain=v1")
            .arg("--untracked-files=all")
            .output(),
    )
    .await
    .map_err(|_| "读取 Git 变更超时，请稍后重试".to_string())?
    .map_err(|e| format!("执行 Git 失败: {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if error.is_empty() {
            return Err("读取 Git 状态失败".to_string());
        }
        return Err(format!("读取 Git 状态失败: {}", error));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut changes: Vec<GitFileChange> = stdout.lines().filter_map(parse_status_line).collect();
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

#[tauri::command]
pub async fn load_git_file_diff(
    workspace_path: String,
    file_path: String,
) -> Result<String, String> {
    let normalized_path = file_path.trim();
    if normalized_path.is_empty() {
        return Err("文件路径不能为空".to_string());
    }

    ensure_git_workspace(&workspace_path).await?;

    let staged_output = timeout(
        Duration::from_secs(10),
        Command::new("git")
            .arg("-C")
            .arg(&workspace_path)
            .arg("diff")
            .arg("--cached")
            .arg("--")
            .arg(normalized_path)
            .output(),
    )
    .await
    .map_err(|_| "读取暂存区 diff 超时，请稍后重试".to_string())?
    .map_err(|e| format!("执行 Git 失败: {}", e))?;

    if !staged_output.status.success() {
        let error = String::from_utf8_lossy(&staged_output.stderr)
            .trim()
            .to_string();
        return Err(if error.is_empty() {
            "读取暂存区 diff 失败".to_string()
        } else {
            format!("读取暂存区 diff 失败: {}", error)
        });
    }

    let unstaged_output = timeout(
        Duration::from_secs(10),
        Command::new("git")
            .arg("-C")
            .arg(&workspace_path)
            .arg("diff")
            .arg("--")
            .arg(normalized_path)
            .output(),
    )
    .await
    .map_err(|_| "读取工作区 diff 超时，请稍后重试".to_string())?
    .map_err(|e| format!("执行 Git 失败: {}", e))?;

    if !unstaged_output.status.success() {
        let error = String::from_utf8_lossy(&unstaged_output.stderr)
            .trim()
            .to_string();
        return Err(if error.is_empty() {
            "读取工作区 diff 失败".to_string()
        } else {
            format!("读取工作区 diff 失败: {}", error)
        });
    }

    let staged = String::from_utf8_lossy(&staged_output.stdout).to_string();
    let unstaged = String::from_utf8_lossy(&unstaged_output.stdout).to_string();

    let mut sections: Vec<String> = Vec::new();
    if !staged.trim().is_empty() {
        sections.push(format!("[暂存区]\n{}", staged.trim()));
    }
    if !unstaged.trim().is_empty() {
        sections.push(format!("[工作区]\n{}", unstaged.trim()));
    }

    if sections.is_empty() {
        return Ok(
            "当前文件没有可展示的 diff（可能是未跟踪文件，或仅有文件状态变化）。".to_string(),
        );
    }

    Ok(sections.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::{parse_status_line, status_code_to_label};

    #[test]
    fn parse_modified_line() {
        let parsed = parse_status_line(" M src/main.ts").expect("should parse");
        assert_eq!(parsed.path, "src/main.ts");
        assert_eq!(parsed.staged_status, "none");
        assert_eq!(parsed.unstaged_status, "modified");
    }

    #[test]
    fn parse_untracked_line() {
        let parsed = parse_status_line("?? docs/notes.md").expect("should parse");
        assert_eq!(parsed.path, "docs/notes.md");
        assert_eq!(parsed.staged_status, "untracked");
        assert_eq!(parsed.unstaged_status, "untracked");
    }

    #[test]
    fn parse_rename_line_uses_target_path() {
        let parsed = parse_status_line("R  src/old.ts -> src/new.ts").expect("should parse");
        assert_eq!(parsed.path, "src/new.ts");
        assert_eq!(parsed.staged_status, "renamed");
        assert_eq!(parsed.unstaged_status, "none");
    }

    #[test]
    fn parse_invalid_line_returns_none() {
        assert!(parse_status_line("x").is_none());
        assert!(parse_status_line("?? ").is_none());
    }

    #[test]
    fn status_code_mapping_works() {
        assert_eq!(status_code_to_label('M'), "modified");
        assert_eq!(status_code_to_label('A'), "added");
        assert_eq!(status_code_to_label('D'), "deleted");
        assert_eq!(status_code_to_label('R'), "renamed");
        assert_eq!(status_code_to_label('?'), "untracked");
        assert_eq!(status_code_to_label(' '), "none");
    }
}
