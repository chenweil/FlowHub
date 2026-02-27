// iFlow Workspace - Main Entry
import { state } from './store';
import {
  applyTheme,
  syncAppVersion,
  setupEventListeners,
  setupTauriEventListeners,
  warmUpArtifactPreviewFrame,
  setSendButtonMode,
  refreshComposerState,
} from './features/app';
import { loadAgents, updateCurrentAgentModelUI } from './features/agents';

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
  refreshComposerState();
  console.log('App initialized');
}

init().catch(console.error);
