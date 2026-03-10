// src/features/agents/index.ts — Agent feature barrel export

// State
export { isCurrentAgentBusy, getCurrentAgent } from './state';

// Utils
export {
  readTextFromUnknown,
  readErrorMessage,
  normalizeConnectionErrorMessage,
  isThinkUnsupportedError,
  readLastConnectedAgentId,
  markLastConnectedAgent,
  removeLastConnectedAgentIfMatches,
  showLoading,
  hideLoading,
  showSuccess,
  showError,
  getThinkSupportByModel,
  setThinkSupportByModel,
} from './utils';

// Actions
export {
  addAgent,
  selectAgent,
  deleteAgent,
  renameAgent,
  hideRenameAgentModal,
  submitRenameAgent,
  onAgentListClick,
  renderAgentList,
  loadAgents,
  saveAgents,
} from './actions';

// UI
export {
  updateAgentStatusUI,
  updateConnectionStatus,
  updateCurrentAgentModelUI,
  updateCurrentAgentThinkUI,
  closeCurrentAgentModelMenu,
  renderCurrentAgentModelMenu,
  currentAgentModelLabel,
} from './ui';

// Model
export {
  normalizeModelOption,
  resolveModelDisplayName,
  filterModelOptions,
  formatModelItem,
  formatModelList,
  loadAgentModelOptions,
  resolveModelName,
  switchAgentModel,
  toggleCurrentAgentModelMenu,
  onCurrentAgentModelMenuClick,
  toggleCurrentAgentThink,
  parseModelSlashCommand,
  handleLocalModelCommand,
  parseAboutPayload,
  extractModelNameFromAboutPayload,
  syncAgentModelFromAboutContent,
} from './model';

// Registry
export {
  normalizeRegistryCommands,
  normalizeRegistryMcpServers,
  applyAgentRegistry,
  applyAgentModelRegistry,
} from './registry';

// Tool Calls
export {
  normalizeToolCallStatus,
  normalizeToolCallItem,
  mergeToolCalls,
  resetToolCallsForAgent,
  openCurrentAgentToolCallsPanel,
} from './tool-calls';

// Git
export {
  showGitChangesForAgent,
  resetGitChangesForAgent,
  refreshAgentGitChanges,
  refreshCurrentAgentGitChanges,
} from './git';

// Reconnect
export {
  type AutoReconnectMode,
  type ReconnectAgentOptions,
  getAutoReconnectMode,
  setAutoReconnectMode,
  reconnectAgent,
  autoReconnectSavedAgents,
  parseAgentAutoReconnectCommand,
} from './reconnect';

// Commands
export { handleLocalAgentCommand } from './commands';

// Types re-export
export type { Agent, ModelOption, ToolCall, RegistryCommand, RegistryMcpServer } from '../../types';
