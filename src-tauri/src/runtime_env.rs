use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

fn push_unique(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    if seen.insert(path.clone()) {
        paths.push(path);
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn runtime_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    if let Some(path_var) = env::var_os("PATH") {
        for item in env::split_paths(&path_var) {
            push_unique(&mut paths, &mut seen, item);
        }
    }

    if let Some(home) = home_dir() {
        push_unique(&mut paths, &mut seen, home.join(".n").join("bin"));
        push_unique(&mut paths, &mut seen, home.join(".npm-global").join("bin"));
        push_unique(&mut paths, &mut seen, home.join(".local").join("bin"));
    }

    #[cfg(target_os = "macos")]
    {
        push_unique(
            &mut paths,
            &mut seen,
            PathBuf::from("/opt/homebrew").join("bin"),
        );
        push_unique(
            &mut paths,
            &mut seen,
            PathBuf::from("/opt/homebrew").join("sbin"),
        );
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/local/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/local/sbin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/sbin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/sbin"));
    }

    #[cfg(target_os = "linux")]
    {
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/local/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/local/sbin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/bin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/usr/sbin"));
        push_unique(&mut paths, &mut seen, PathBuf::from("/sbin"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
            push_unique(
                &mut paths,
                &mut seen,
                user_profile.join("AppData").join("Roaming").join("npm"),
            );
        }
    }

    paths
}

fn is_file_path(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

pub fn runtime_path_env() -> Result<OsString, String> {
    let paths = runtime_search_paths();
    env::join_paths(paths).map_err(|e| format!("Failed to build PATH: {}", e))
}

pub fn resolve_executable_path(executable: &str) -> Result<PathBuf, String> {
    let trimmed = executable.trim();
    if trimmed.is_empty() {
        return Err("Executable path cannot be empty".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    if input_path.is_absolute() || trimmed.contains(std::path::MAIN_SEPARATOR) {
        if is_file_path(&input_path) {
            return Ok(std::fs::canonicalize(&input_path).unwrap_or(input_path));
        }
        return Err(format!("Executable not found: {}", trimmed));
    }

    for search_path in runtime_search_paths() {
        let candidate = search_path.join(trimmed);
        if is_file_path(&candidate) {
            return Ok(std::fs::canonicalize(&candidate).unwrap_or(candidate));
        }
    }

    Err(format!("Executable not found in runtime PATH: {}", trimmed))
}
