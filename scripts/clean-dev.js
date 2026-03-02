#!/usr/bin/env node
/**
 * 跨平台开发环境清理脚本
 * 清理残留的端口监听进程和项目调试二进制进程
 */

import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 1420;
const WORKSPACE_DIR = path.resolve(__dirname, '..');

/**
 * 跨平台执行命令并返回输出
 */
function execAsync(command, options = {}) {
  return new Promise((resolve) => {
    exec(command, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '', error });
    });
  });
}

/**
 * 检查是否为 Windows 平台
 */
function isWindows() {
  return process.platform === 'win32';
}

/**
 * 终止进程
 */
async function killProcess(pid, desc) {
  if (isWindows()) {
    // Windows: 使用 taskkill
    await execAsync(`taskkill /PID ${pid} /F 2>nul`);
  } else {
    // Unix: 使用 kill
    await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
  }
  console.log(`    已清理 ${desc} (PID: ${pid})`);
}

/**
 * 清理端口监听进程
 */
async function cleanupPortListener() {
  console.log(`  → 检查端口 ${PORT}...`);

  let pids = [];

  if (isWindows()) {
    // Windows: 使用 netstat 查找端口监听进程
    const { stdout } = await execAsync(`netstat -ano | findstr :${PORT} | findstr LISTENING`);
    if (stdout) {
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.trim().match(/\s+(\d+)\s*$/);
        if (match) {
          pids.push(match[1]);
        }
      }
    }
  } else {
    // Unix: 使用 lsof
    const { stdout } = await execAsync(`lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true`);
    if (stdout) {
      pids = stdout.split('\n').filter(p => p.trim());
    }
  }

  if (pids.length === 0) {
    console.log(`    端口 ${PORT} 未占用`);
    return;
  }

  for (const pid of pids) {
    if (pid) {
      await killProcess(pid, `端口 ${PORT} 监听进程`);
    }
  }
}

/**
 * 清理项目调试二进制进程
 */
async function cleanupProjectBinary() {
  console.log('  → 检查当前项目调试二进制进程...');

  const binaryPattern = isWindows()
    ? path.join(WORKSPACE_DIR, 'src-tauri', 'target').replace(/\\/g, '\\\\')
    : `${WORKSPACE_DIR}/src-tauri/target`;

  let pids = [];

  if (isWindows()) {
    // Windows: 使用 wmic 查找进程
    const { stdout } = await execAsync(
      `wmic process where "ExecutablePath like '${binaryPattern}%' and Name like '%iflow-workspace%'" get ProcessId 2>nul`
    );
    if (stdout) {
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)$/);
        if (match) {
          pids.push(match[1]);
        }
      }
    }

    // 备用: 仅检测同名进程，不直接按进程名清理，避免误杀其他项目实例
    if (pids.length === 0) {
      const { stdout: tasklistOut } = await execAsync(
        `tasklist /FI "IMAGENAME eq iflow-workspace.exe" /FO CSV 2>nul`
      );
      if (tasklistOut && !tasklistOut.includes('INFO: No tasks')) {
        console.log('    检测到 iflow-workspace.exe 同名进程，但无法确认路径，已跳过清理以避免误杀');
      }
    }
  } else {
    // Unix: 使用 pgrep
    const { stdout } = await execAsync(
      `pgrep -f "${binaryPattern}.*/iflow-workspace" 2>/dev/null || true`
    );
    if (stdout) {
      pids = stdout.split('\n').filter(p => p.trim());
    }
  }

  if (pids.length === 0) {
    console.log('    无当前项目调试二进制进程');
    return;
  }

  for (const pid of pids) {
    if (pid) {
      await killProcess(pid, '调试二进制进程');
    }
  }
}

/**
 * 主函数
 */
async function main() {
  console.log('🧹 清理 FlowHub 开发环境...\n');

  await cleanupPortListener();
  await cleanupProjectBinary();

  console.log('\n✅ 清理完成');
  console.log('现在可以运行: npm run tauri:dev');
}

main().catch((err) => {
  console.error('清理失败:', err.message);
  process.exit(1);
});
