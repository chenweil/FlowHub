// src/features/agents/ui.ts — Agent UI updates
import type { Agent, ModelOption } from '../../types';
import { state } from '../../store';
import {
  currentAgentStatusEl,
  currentAgentModelBtnEl,
  currentAgentModelTextEl,
  currentAgentModelMenuEl,
  toggleThinkBtnEl,
  connectionStatusEl,
} from '../../dom';
import { escapeHtml } from '../../lib/html';
import { getThinkSupportByModel } from './utils';
import { resolveModelDisplayName } from './model';

// ── Status UI ─────────────────────────────────────────────────────────────────

export function updateAgentStatusUI(status: Agent['status']) {
  const statusText = {
    disconnected: '离线',
    connecting: '连接中...',
    connected: '在线',
    error: '错误',
  }[status];

  currentAgentStatusEl.textContent = statusText;
  currentAgentStatusEl.className = `badge${status === 'connected' ? ' connected' : ''}`;
  updateCurrentAgentModelUI();
  updateCurrentAgentThinkUI();
}

export function updateConnectionStatus(connected: boolean) {
  const dot = connectionStatusEl.querySelector('.status-dot') as HTMLSpanElement;
  const text = connectionStatusEl.querySelector('span:last-child') as HTMLSpanElement;
  if (connected) {
    dot.className = 'status-dot connected';
    text.textContent = '已连接';
  } else {
    dot.className = 'status-dot disconnected';
    text.textContent = '未连接';
  }
}

// ── Model Selector UI ─────────────────────────────────────────────────────────

export function updateCurrentAgentModelUI() {
  const agent = state.currentAgentId
    ? state.agents.find((item) => item.id === state.currentAgentId)
    : null;
  if (!agent) {
    currentAgentModelBtnEl.disabled = true;
    currentAgentModelTextEl.textContent = '模型：未连接';
    closeCurrentAgentModelMenu();
    return;
  }

  if (state.modelSwitchingAgentId === agent.id) {
    currentAgentModelBtnEl.disabled = true;
    currentAgentModelTextEl.textContent = '模型：切换中...';
    return;
  }

  currentAgentModelTextEl.textContent = `模型：${currentAgentModelLabel(agent)}`;
  currentAgentModelBtnEl.title = currentAgentModelLabel(agent);
  currentAgentModelBtnEl.disabled = agent.status !== 'connected';

  if (agent.status !== 'connected') {
    closeCurrentAgentModelMenu();
  }
}

export function currentAgentModelLabel(agent: Agent): string {
  const selected = agent.selectedModel?.trim();
  if (selected && selected.length > 0) {
    return selected;
  }

  const cached = state.modelOptionsCacheByAgent[agent.id];
  if (cached && cached.length > 0) {
    return `${resolveModelDisplayName(cached[0])}（默认）`;
  }
  return 'Qwen 默认模型';
}

export function updateCurrentAgentThinkUI() {
  const agent = state.currentAgentId
    ? state.agents.find((item) => item.id === state.currentAgentId)
    : null;
  if (!agent) {
    toggleThinkBtnEl.disabled = true;
    toggleThinkBtnEl.classList.remove('active', 'loading', 'unsupported');
    toggleThinkBtnEl.textContent = '思考：关';
    toggleThinkBtnEl.title = '思考：未连接';
    return;
  }

  const supportStatus = getThinkSupportByModel(agent.selectedModel);
  const unsupported = supportStatus === 'unsupported';
  const enabled = !unsupported && Boolean(agent.thinkEnabled);
  const switching = state.thinkSwitchingAgentId === agent.id;
  toggleThinkBtnEl.classList.toggle('active', enabled);
  toggleThinkBtnEl.classList.toggle('loading', switching);
  toggleThinkBtnEl.classList.toggle('unsupported', unsupported);
  toggleThinkBtnEl.textContent = unsupported ? '思考：不支持' : `思考：${enabled ? '开' : '关'}`;
  toggleThinkBtnEl.title = switching
    ? '切换中...'
    : unsupported
      ? '当前模型不支持思考模式'
      : enabled
        ? '点击关闭思考模式'
        : '点击开启思考模式';
  toggleThinkBtnEl.disabled = agent.status !== 'connected' || switching || unsupported;
}

// ── Model Menu ─────────────────────────────────────────────────────────────────

export function closeCurrentAgentModelMenu() {
  state.modelSelectorOpen = false;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'false');
  currentAgentModelMenuEl.classList.add('hidden');
}

export function isModelOptionActive(agent: Agent, option: ModelOption, index: number): boolean {
  const selected = agent.selectedModel?.trim().toLowerCase();
  if (!selected) {
    return index === 0;
  }
  return (
    option.value.trim().toLowerCase() === selected ||
    option.label.trim().toLowerCase() === selected
  );
}

export function renderCurrentAgentModelMenu(agent: Agent, options: ModelOption[]) {
  if (options.length === 0) {
    currentAgentModelMenuEl.innerHTML =
      '<div class="model-selector-state">当前无法读取模型列表，请稍后重试。</div>';
    return;
  }

  currentAgentModelMenuEl.innerHTML = options
    .map((option, index) => {
      const active = isModelOptionActive(agent, option, index);
      return `
      <button
        type="button"
        class="model-option-item ${active ? 'active' : ''}"
        data-model-value="${escapeHtml(option.value)}"
      >
        <span class="model-option-name">${escapeHtml(resolveModelDisplayName(option))}</span>
        <span class="model-option-tag">${active ? '当前' : ''}</span>
      </button>
    `;
    })
    .join('');
}

