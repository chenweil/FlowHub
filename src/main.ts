// iFlow Workspace - Main Entry
import { state } from './store';
import {
  applyTheme,
  syncAppVersion,
  setupEventListeners,
  setupTauriEventListeners,
  setSendButtonMode,
  refreshComposerState,
} from './features/app';
import { loadAgents, updateCurrentAgentModelUI, updateCurrentAgentThinkUI } from './features/agents';
import { warmUpArtifactPreviewFrame } from './features/ui';
import { persistStorageSnapshot, buildStorageSnapshot } from './features/storage';

async function init() {
  console.log('Initializing app...');
  applyTheme(state.currentTheme);
  await syncAppVersion();
  await loadAgents();
  setupEventListeners();
  setupTauriEventListeners();
  warmUpArtifactPreviewFrame();
  setSendButtonMode('send', true);
  updateCurrentAgentModelUI();
  updateCurrentAgentThinkUI();
  refreshComposerState();

  setInterval(() => {
    if (!state.currentAgentId) {
      return;
    }
    if (state.inflightSessionByAgent[state.currentAgentId]) {
      refreshComposerState();
    }
  }, 1000);
  
  // 定期保存（每30秒）
  setInterval(() => {
    const snapshot = buildStorageSnapshot();
    void persistStorageSnapshot(snapshot);
  }, 30000);
  
  // 页面卸载时保存
  window.addEventListener('beforeunload', () => {
    const snapshot = buildStorageSnapshot();
    void persistStorageSnapshot(snapshot);
  });
  
  console.log('App initialized');
}

init().catch(console.error);
