// src/services/tauri.ts - Typed wrappers for Tauri invoke calls
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import type {
  IflowHistorySessionRecord,
  IflowHistoryMessageRecord,
  ModelOption,
  SkillRuntimeItem,
  StorageSnapshot,
  GitFileChange,
} from '../types';

export { convertFileSrc, getVersion };

export interface ConnectIflowResult {
  success: boolean;
  port: number;
  error?: string;
}

export function readHtmlArtifact(agentId: string, filePath: string): Promise<string> {
  return invoke<string>('read_html_artifact', { agentId, filePath });
}

export function resolveHtmlArtifactPath(agentId: string, filePath: string): Promise<string> {
  return invoke<string>('resolve_html_artifact_path', { agentId, filePath });
}

export function clearIflowHistorySessions(workspacePath: string): Promise<number> {
  return invoke<number>('clear_iflow_history_sessions', { workspacePath });
}

export function connectIflow(
  agentId: string,
  iflowPath: string,
  workspacePath: string,
  model: string | null,
): Promise<ConnectIflowResult> {
  return invoke<ConnectIflowResult>('connect_iflow', { agentId, iflowPath, workspacePath, model });
}

export function listIflowHistorySessions(workspacePath: string): Promise<IflowHistorySessionRecord[]> {
  return invoke<IflowHistorySessionRecord[]>('list_iflow_history_sessions', { workspacePath });
}

export function loadIflowHistoryMessages(
  workspacePath: string,
  sessionId: string,
): Promise<IflowHistoryMessageRecord[]> {
  return invoke<IflowHistoryMessageRecord[]>('load_iflow_history_messages', {
    workspacePath,
    sessionId,
  });
}

export function disconnectAgent(agentId: string): Promise<void> {
  return invoke('disconnect_agent', { agentId });
}

export function deleteIflowHistorySession(
  workspacePath: string,
  sessionId: string,
): Promise<boolean> {
  return invoke<boolean>('delete_iflow_history_session', { workspacePath, sessionId });
}

export function listAvailableModels(iflowPath: string): Promise<ModelOption[]> {
  return invoke<ModelOption[]>('list_available_models', { iflowPath });
}

export function switchAgentModel(
  agentId: string,
  iflowPath: string,
  workspacePath: string,
  model: string,
): Promise<ConnectIflowResult> {
  return invoke<ConnectIflowResult>('switch_agent_model', {
    agentId,
    iflowPath,
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
