// src/services/tauri.ts - Typed wrappers for Tauri invoke calls
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import type {
  QwenHistorySessionRecord,
  QwenHistoryMessageRecord,
  SkillRuntimeItem,
  StorageSnapshot,
  GitFileChange,
  FileItem,
} from '../types';

export { convertFileSrc, getVersion };

export interface ConnectQwenResult {
  success: boolean;
  error?: string;
}

export function readHtmlArtifact(agentId: string, filePath: string): Promise<string> {
  return invoke<string>('read_html_artifact', { agentId, filePath });
}

export function resolveHtmlArtifactPath(agentId: string, filePath: string): Promise<string> {
  return invoke<string>('resolve_html_artifact_path', { agentId, filePath });
}

export function clearQwenHistorySessions(workspacePath: string): Promise<number> {
  return invoke<number>('clear_qwen_history_sessions', { workspacePath });
}

export function connectQwen(
  agentId: string,
  qwenPath: string,
  workspacePath: string,
  model: string | null,
): Promise<ConnectQwenResult> {
  return invoke<ConnectQwenResult>('connect_qwen', { agentId, qwenPath, workspacePath, model });
}

export function listQwenHistorySessions(workspacePath: string): Promise<QwenHistorySessionRecord[]> {
  return invoke<QwenHistorySessionRecord[]>('list_qwen_history_sessions', { workspacePath });
}

export function loadQwenHistoryMessages(
  workspacePath: string,
  sessionId: string,
): Promise<QwenHistoryMessageRecord[]> {
  return invoke<QwenHistoryMessageRecord[]>('load_qwen_history_messages', {
    workspacePath,
    sessionId,
  });
}

export function disconnectAgent(agentId: string): Promise<void> {
  return invoke('disconnect_agent', { agentId });
}

export function deleteQwenHistorySession(
  workspacePath: string,
  sessionId: string,
): Promise<boolean> {
  return invoke<boolean>('delete_qwen_history_session', { workspacePath, sessionId });
}

export function switchQwenModel(
  agentId: string,
  qwenPath: string,
  workspacePath: string,
  model: string,
): Promise<ConnectQwenResult> {
  return invoke<ConnectQwenResult>('switch_qwen_model', {
    agentId,
    qwenPath,
    workspacePath,
    model,
  });
}

export function toggleAgentThink(
  agentId: string,
  enable: boolean,
  config: string | null = null,
): Promise<void> {
  return invoke('toggle_agent_think', { agentId, enable, config });
}

export function sendMessage(
  agentId: string,
  content: string,
  sessionId: string | null,
): Promise<void> {
  return invoke('send_message', { agentId, content, sessionId });
}

export function stopMessage(agentId: string): Promise<void> {
  return invoke('stop_message', { agentId });
}

export function loadStorageSnapshot(): Promise<StorageSnapshot> {
  return invoke<StorageSnapshot>('load_storage_snapshot');
}

export function saveStorageSnapshot(snapshot: StorageSnapshot): Promise<void> {
  return invoke('save_storage_snapshot', { snapshot });
}

export function listGitChanges(workspacePath: string): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>('list_git_changes', { workspacePath });
}

export function loadGitFileDiff(workspacePath: string, filePath: string): Promise<string> {
  return invoke<string>('load_git_file_diff', { workspacePath, filePath });
}

export function pickFolder(defaultPath: string | null): Promise<string | null> {
  return invoke<string | null>('pick_folder', { defaultPath });
}

export function discoverSkills(agentType: string): Promise<SkillRuntimeItem[]> {
  return invoke<SkillRuntimeItem[]>('discover_skills', { agentType });
}

export function listWorkspaceFiles(workspacePath: string): Promise<FileItem[]> {
  return invoke<FileItem[]>('list_workspace_files', { workspacePath });
}
