// iFlow Workspace - Main Entry
import { state } from './store';
import {
  applyTheme,
  syncAppVersion,
  loadAgents,
  setupEventListeners,
  setupTauriEventListeners,
  warmUpArtifactPreviewFrame,
  setSendButtonMode,
  updateCurrentAgentModelUI,
  refreshComposerState,
} from './features/app';

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
