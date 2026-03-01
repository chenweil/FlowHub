// src/dom.ts — DOM element references

export const addAgentBtnEl = document.getElementById('add-agent-btn') as HTMLButtonElement;
export const agentListEl = document.getElementById('agent-list') as HTMLDivElement;
export const sessionListEl = document.getElementById('session-list') as HTMLDivElement;
export const chatMessagesEl = document.getElementById('chat-messages') as HTMLDivElement;
export const messageInputEl = document.getElementById('message-input') as HTMLTextAreaElement;
export const sendBtnEl = document.getElementById('send-btn') as HTMLButtonElement;
export const addAgentModalEl = document.getElementById('add-agent-modal') as HTMLDivElement;
export const closeModalBtnEl = document.getElementById('close-modal') as HTMLButtonElement;
export const cancelAddAgentBtnEl = document.getElementById('cancel-add-agent') as HTMLButtonElement;
export const confirmAddAgentBtnEl = document.getElementById('confirm-add-agent') as HTMLButtonElement;
export const workspacePathInputEl = document.getElementById('workspace-path') as HTMLInputElement;
export const browseWorkspacePathBtnEl = document.getElementById('browse-workspace-path') as HTMLButtonElement;
export const renameAgentModalEl = document.getElementById('rename-agent-modal') as HTMLDivElement;
export const closeRenameAgentModalBtnEl = document.getElementById(
  'close-rename-agent-modal'
) as HTMLButtonElement;
export const cancelRenameAgentBtnEl = document.getElementById(
  'cancel-rename-agent'
) as HTMLButtonElement;
export const confirmRenameAgentBtnEl = document.getElementById(
  'confirm-rename-agent'
) as HTMLButtonElement;
export const renameAgentNameInputEl = document.getElementById('rename-agent-name') as HTMLInputElement;
export const currentAgentNameEl = document.getElementById('current-agent-name') as HTMLHeadingElement;
export const currentAgentStatusEl = document.getElementById('current-agent-status') as HTMLSpanElement;
export const currentAgentModelBtnEl = document.getElementById('current-agent-model-btn') as HTMLButtonElement;
export const currentAgentModelTextEl = document.getElementById('current-agent-model-text') as HTMLSpanElement;
export const currentAgentModelMenuEl = document.getElementById('current-agent-model-menu') as HTMLDivElement;
export const toggleThinkBtnEl = document.getElementById('toggle-think-btn') as HTMLButtonElement;
export const openToolCallsBtnEl = document.getElementById('open-tool-calls-btn') as HTMLButtonElement;
export const openGitChangesBtnEl = document.getElementById('open-git-changes-btn') as HTMLButtonElement;
export const toolCallsPanelEl = document.getElementById('tool-calls-panel') as HTMLDivElement;
export const toolCallsListEl = document.getElementById('tool-calls-list') as HTMLDivElement;
export const closeToolPanelBtnEl = document.getElementById('close-tool-panel') as HTMLButtonElement;
export const gitChangesPanelEl = document.getElementById('git-changes-panel') as HTMLDivElement;
export const gitChangesListEl = document.getElementById('git-changes-list') as HTMLDivElement;
export const gitChangesRefreshTimeEl = document.getElementById('git-changes-refresh-time') as HTMLSpanElement;
export const refreshGitChangesBtnEl = document.getElementById('refresh-git-changes') as HTMLButtonElement;
export const closeGitChangesPanelBtnEl = document.getElementById('close-git-panel') as HTMLButtonElement;
export const newSessionBtnEl = document.getElementById('new-session-btn') as HTMLButtonElement;
export const clearChatBtnEl = document.getElementById('clear-chat-btn') as HTMLButtonElement;
export const connectionStatusEl = document.getElementById('connection-status') as HTMLDivElement;
export const clearAllSessionsBtnEl = document.getElementById('clear-all-sessions') as HTMLButtonElement;
export const inputStatusHintEl = document.getElementById('input-status-hint') as HTMLSpanElement;
export const slashCommandMenuEl = document.getElementById('slash-command-menu') as HTMLDivElement;
export const artifactPreviewModalEl = document.getElementById('artifact-preview-modal') as HTMLDivElement;
export const closeArtifactPreviewBtnEl = document.getElementById('close-artifact-preview') as HTMLButtonElement;
export const artifactPreviewPathEl = document.getElementById('artifact-preview-path') as HTMLDivElement;
export const artifactPreviewFrameEl = document.getElementById('artifact-preview-frame') as HTMLIFrameElement;
export const gitDiffModalEl = document.getElementById('git-diff-modal') as HTMLDivElement;
export const closeGitDiffBtnEl = document.getElementById('close-git-diff') as HTMLButtonElement;
export const gitDiffPathEl = document.getElementById('git-diff-path') as HTMLSpanElement;
export const gitDiffContentEl = document.getElementById('git-diff-content') as HTMLPreElement;
export const themeToggleBtnEl = document.getElementById('theme-toggle-btn') as HTMLButtonElement;
export const appVersionEl = document.getElementById('app-version') as HTMLDivElement;
