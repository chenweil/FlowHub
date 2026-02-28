#!/bin/bash
# 清理当前项目开发环境残留进程（精准清理，避免误杀其他项目）

set -u

PORT=1420
WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "🧹 清理 flow hub 开发环境..."

kill_with_fallback() {
  local pid="$1"
  local desc="$2"

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  sleep 0.3

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  echo "    已清理 ${desc} (PID: ${pid})"
}

cleanup_port_listener() {
  echo "  → 检查端口 ${PORT}..."
  local pids
  pids="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"

  if [ -z "$pids" ]; then
    echo "    端口 ${PORT} 未占用"
    return 0
  fi

  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    kill_with_fallback "$pid" "端口 ${PORT} 监听进程"
  done <<< "$pids"
}

cleanup_project_binary() {
  echo "  → 检查当前项目调试二进制进程..."
  local pids
  pids="$(pgrep -f "${WORKSPACE_DIR}/src-tauri/target/.*/iflow-workspace" 2>/dev/null || true)"

  if [ -z "$pids" ]; then
    echo "    无当前项目调试二进制进程"
    return 0
  fi

  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    kill_with_fallback "$pid" "调试二进制进程"
  done <<< "$pids"
}

cleanup_port_listener
cleanup_project_binary

echo ""
echo "✅ 清理完成"
echo "现在可以运行: npm run tauri:dev"
