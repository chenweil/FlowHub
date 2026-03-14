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
export const toolbarMoreBtnEl = document.getElementById('toolbar-more-btn') as HTMLButtonElement;
export const toolbarMoreMenuEl = document.getElementById('toolbar-more-menu') as HTMLDivElement;
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
export const openSettingsBtnEl = document.getElementById('open-settings-btn') as HTMLButtonElement;
export const settingsModalEl = document.getElementById('settings-modal') as HTMLDivElement;
export const closeSettingsModalBtnEl = document.getElementById(
  'close-settings-modal'
) as HTMLButtonElement;
export const closeSettingsFooterBtnEl = document.getElementById(
  'close-settings-footer-btn'
) as HTMLButtonElement;
export const themeToggleBtnEl = document.getElementById('theme-toggle-btn') as HTMLButtonElement;
export const autoReconnectModeSelectEl = document.getElementById(
  'auto-reconnect-mode-select'
) as HTMLSelectElement;
export const notificationSoundSelectEl = document.getElementById('notification-sound-select') as HTMLSelectElement;
export const notificationDelayMinuteInputEl = document.getElementById(
  'notification-delay-minute'
) as HTMLInputElement;
export const notificationDelaySecondInputEl = document.getElementById(
  'notification-delay-second'
) as HTMLInputElement;
export const notificationSoundUploadBtnEl = document.getElementById(
  'notification-sound-upload-btn'
) as HTMLButtonElement;
export const notificationSoundUploadInputEl = document.getElementById(
  'notification-sound-upload-input'
) as HTMLInputElement;
export const sendKeyModeSelectEl = document.getElementById(
  'send-key-mode-select'
) as HTMLSelectElement;
export const appVersionEl = document.getElementById('app-version') as HTMLDivElement;

// Confirm modal
export const confirmModalEl = document.getElementById('confirm-modal') as HTMLDivElement;
export const confirmTitleEl = document.getElementById('confirm-modal-title') as HTMLHeadingElement;
export const confirmMessageEl = document.getElementById('confirm-message') as HTMLParagraphElement;
export const closeConfirmModalBtnEl = document.getElementById('close-confirm-modal') as HTMLButtonElement;
export const confirmCancelBtnEl = document.getElementById('confirm-cancel') as HTMLButtonElement;
export const confirmOkBtnEl = document.getElementById('confirm-ok') as HTMLButtonElement;

// ── Confirm dialog ────────────────────────────────────────────────────────

type ConfirmDialogOptions = { okText?: string; cancelText?: string };

let confirmResolve: ((result: boolean) => void) | null = null;
let isConfirmDialogOpen = false;
let confirmQueue: Array<{
  title: string;
  message: string;
  resolve: (result: boolean) => void;
  options?: ConfirmDialogOptions;
}> = [];
const defaultConfirmOkText = confirmOkBtnEl.textContent || '确认';
const defaultConfirmCancelText = confirmCancelBtnEl.textContent || '取消';

// ── Focus trap management ──────────────────────────────────────────────────

let lastFocusedElement: HTMLElement | null = null;

export function trapFocusInModal(modalEl: HTMLElement) {
  // 保存当前焦点元素
  lastFocusedElement = document.activeElement as HTMLElement;

  // 查找第一个可聚焦元素
  const focusableSelectors = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusableElements = modalEl.querySelectorAll<HTMLElement>(focusableSelectors);
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  // 移动焦点到第一个元素
  if (firstFocusable) {
    firstFocusable.focus();
  }

  // 焦点陷阱
  function trapFocus(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      // Shift + Tab
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable?.focus();
      }
    } else {
      // Tab
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable?.focus();
      }
    }
  }

  modalEl.addEventListener('keydown', trapFocus);

  // 返回清理函数
  return () => {
    modalEl.removeEventListener('keydown', trapFocus);
    // 恢复焦点
    lastFocusedElement?.focus();
  };
}

export function showConfirmDialog(
  title: string,
  message: string,
  options?: ConfirmDialogOptions
): Promise<boolean> {
  return new Promise((resolve) => {
    // 如果弹窗已打开，将请求加入队列
    if (isConfirmDialogOpen) {
      confirmQueue.push({ title, message, resolve, options });
      return;
    }
    
    isConfirmDialogOpen = true;
    confirmTitleEl.textContent = title;
    confirmMessageEl.textContent = message;
    confirmOkBtnEl.textContent = options?.okText || defaultConfirmOkText;
    confirmCancelBtnEl.textContent = options?.cancelText || defaultConfirmCancelText;
    confirmModalEl.classList.remove('hidden');
    confirmResolve = resolve;
    
    // 焦点陷阱
    const cleanup = trapFocusInModal(confirmModalEl);
    confirmModalEl.dataset.focusCleanup = 'true';
    (confirmModalEl as any)._focusCleanup = cleanup;
  });
}

function closeConfirmDialog(result: boolean) {
  confirmModalEl.classList.add('hidden');
  confirmOkBtnEl.textContent = defaultConfirmOkText;
  confirmCancelBtnEl.textContent = defaultConfirmCancelText;
  
  // 清理焦点陷阱
  const cleanup = (confirmModalEl as any)._focusCleanup;
  if (cleanup) {
    cleanup();
    delete (confirmModalEl as any)._focusCleanup;
  }
  
  if (confirmResolve) {
    confirmResolve(result);
    confirmResolve = null;
  }
  
  isConfirmDialogOpen = false;
  
  // 处理队列中的下一个请求
  const next = confirmQueue.shift();
  if (next) {
    // 使用 setTimeout 确保 DOM 状态稳定后再打开下一个弹窗
    setTimeout(() => {
      void showConfirmDialog(next.title, next.message, next.options).then(next.resolve);
    }, 0);
  }
}

closeConfirmModalBtnEl.addEventListener('click', () => closeConfirmDialog(false));
confirmCancelBtnEl.addEventListener('click', () => closeConfirmDialog(false));
confirmOkBtnEl.addEventListener('click', () => closeConfirmDialog(true));
confirmModalEl.addEventListener('click', (e) => {
  if (e.target === confirmModalEl) {
    closeConfirmDialog(false);
  }
});
