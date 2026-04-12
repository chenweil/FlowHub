// src/features/agents/model.ts — Model management
import { switchQwenModel as tauriSwitchQwenModel, toggleAgentThink as tauriToggleAgentThink } from '../../services/tauri';
import type { Agent, Message, ModelOption, ParsedModelSlashCommand } from '../../types';
import { state } from '../../store';
import { readErrorMessage, readTextFromUnknown, isThinkUnsupportedError, getThinkSupportByModel, setThinkSupportByModel, showError, showSuccess } from './utils';
import { renderAgentList, saveAgents } from './actions';
import { updateCurrentAgentModelUI, updateCurrentAgentThinkUI, updateAgentStatusUI, renderCurrentAgentModelMenu, closeCurrentAgentModelMenu, currentAgentModelLabel } from './ui';

// ── Session helpers (avoid circular dependency) ───────────────────────────────

function getMessagesForSession(sessionId: string): Message[] {
  if (!state.messagesBySession[sessionId]) {
    state.messagesBySession[sessionId] = [];
  }
  return state.messagesBySession[sessionId];
}

function commitSessionMessages(sessionId: string, messages: Message[]): void {
  state.messagesBySession[sessionId] = messages;
  void import('../storage').then(({ saveSessionMessages }) => {
    saveSessionMessages();
  });
}

// ── Model Option Utilities ────────────────────────────────────────────────────

export function normalizeModelOption(raw: unknown): ModelOption | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const value = readTextFromUnknown(record.value);
  if (!value) {
    return null;
  }

  const labelCandidate = readTextFromUnknown(record.label);
  return {
    value,
    label: labelCandidate || value,
  };
}

export function resolveModelDisplayName(option: ModelOption): string {
  const label = option.label.trim();
  const value = option.value.trim();
  return label.length > 0 ? label : value;
}

export function filterModelOptions(models: ModelOption[], keyword?: string): ModelOption[] {
  if (!keyword) {
    return models;
  }

  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return models;
  }

  return models.filter((item) => {
    const haystack = `${item.label} ${item.value}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function formatModelItem(item: ModelOption, index: number): string {
  const labelDiffers = item.label.toLowerCase() !== item.value.toLowerCase();
  return labelDiffers ? `${index}. ${item.value}（${item.label}）` : `${index}. ${item.value}`;
}

export function formatModelList(models: ModelOption[], keyword?: string): string {
  const filtered = filterModelOptions(models, keyword);
  if (filtered.length === 0) {
    return `🧠 未找到匹配模型：${keyword || ''}\n可先输入 /model list 查看全部模型`;
  }

  const lines = filtered.map((model, index) => formatModelItem(model, index + 1));

  const suffix = keyword ? `（筛选：${keyword}）` : '';
  return `🧠 可选模型${suffix}：\n${lines.join('\n')}\n\n用法：\n/model current\n/model <模型名>\n/model <编号>\n示例：/model 1`;
}

// ── Model Loading ─────────────────────────────────────────────────────────────

export async function loadAgentModelOptions(agent: Agent, forceRefresh = false): Promise<ModelOption[]> {
  if (!forceRefresh && state.modelOptionsCacheByAgent[agent.id] && state.modelOptionsCacheByAgent[agent.id].length > 0) {
    return state.modelOptionsCacheByAgent[agent.id];
  }

  const cached = state.modelOptionsCacheByAgent[agent.id] || [];
  if (cached.length > 0 && state.currentAgentId === agent.id) {
    updateCurrentAgentModelUI();
  }
  return cached;
}

// ── Model Switching ───────────────────────────────────────────────────────────

export function resolveModelName(input: string, models: ModelOption[]): {
  modelName: string;
  fromIndex: boolean;
  invalidIndex: boolean;
  fromAlias: boolean;
} {
  const normalized = input.trim();
  if (!normalized) {
    return { modelName: '', fromIndex: false, invalidIndex: false, fromAlias: false };
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= models.length) {
      return { modelName: models[index - 1].value, fromIndex: true, invalidIndex: false, fromAlias: false };
    }
    return { modelName: '', fromIndex: false, invalidIndex: true, fromAlias: false };
  }

  const targetLowerCase = normalized.toLowerCase();
  const matched = models.find(
    (item) =>
      item.value.toLowerCase() === targetLowerCase || item.label.toLowerCase() === targetLowerCase
  );
  if (matched) {
    return {
      modelName: matched.value,
      fromIndex: false,
      invalidIndex: false,
      fromAlias: matched.value.toLowerCase() !== targetLowerCase,
    };
  }

  return { modelName: normalized, fromIndex: false, invalidIndex: false, fromAlias: false };
}

export async function switchQwenModel(agent: Agent, modelName: string): Promise<string | null> {
  const targetModel = modelName.trim();
  if (!targetModel) {
    return '模型名称不能为空';
  }

  state.modelSwitchingAgentId = agent.id;
  agent.status = 'connecting';
  renderAgentList();
  if (state.currentAgentId === agent.id) {
    updateAgentStatusUI(agent.status);
  }
  void import('../app').then(({ refreshComposerState }) => {
    refreshComposerState();
  });

  try {
    const result = await tauriSwitchQwenModel(
      agent.id,
      agent.qwenPath || 'qwen',
      agent.workspacePath,
      targetModel
    );

    if (!result.success) {
      throw new Error(result.error || '模型切换失败');
    }

    agent.status = 'connected';
    agent.selectedModel = targetModel;
    if (agent.thinkEnabled) {
      try {
        await tauriToggleAgentThink(agent.id, true, 'think');
        setThinkSupportByModel(agent.selectedModel, 'supported');
      } catch (error) {
        if (isThinkUnsupportedError(error)) {
          setThinkSupportByModel(agent.selectedModel, 'unsupported');
          agent.thinkEnabled = false;
          console.warn('Restore think mode after model switch failed: target model does not support think mode');
        } else {
          console.error('Restore think mode after model switch failed:', error);
        }
      }
    }
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    void import('../app').then(({ refreshComposerState }) => {
      refreshComposerState();
    });
    return null;
  } catch (error) {
    console.error('Model switch error:', error);
    agent.status = 'error';
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    void import('../app').then(({ refreshComposerState }) => {
      refreshComposerState();
    });
    return String(error);
  } finally {
    state.modelSwitchingAgentId = null;
    if (state.currentAgentId === agent.id) {
      updateCurrentAgentModelUI();
      updateCurrentAgentThinkUI();
    }
  }
}

// ── Model Selector UI ─────────────────────────────────────────────────────────

export async function toggleCurrentAgentModelMenu() {
  const agent = state.currentAgentId
    ? state.agents.find((item) => item.id === state.currentAgentId)
    : null;
  if (!agent || agent.status !== 'connected') {
    return;
  }

  if (state.modelSelectorOpen) {
    closeCurrentAgentModelMenu();
    return;
  }

  const { currentAgentModelMenuEl, currentAgentModelBtnEl } = await import('../../dom');
  state.modelSelectorOpen = true;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'true');
  currentAgentModelMenuEl.classList.remove('hidden');
  currentAgentModelMenuEl.innerHTML = '<div class="model-selector-state">正在加载模型列表...</div>';

  const options = await loadAgentModelOptions(agent);
  if (!state.modelSelectorOpen || state.currentAgentId !== agent.id) {
    return;
  }
  renderCurrentAgentModelMenu(agent, options);
}

export async function onCurrentAgentModelMenuClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const optionBtn = target.closest('button[data-model-value]') as HTMLButtonElement | null;
  if (!optionBtn) {
    return;
  }

  const modelName = optionBtn.dataset.modelValue?.trim();
  const agent = state.currentAgentId
    ? state.agents.find((item) => item.id === state.currentAgentId)
    : null;
  if (!agent || !modelName || agent.status !== 'connected') {
    return;
  }

  const selected = agent.selectedModel?.trim().toLowerCase();
  if (selected === modelName.toLowerCase()) {
    closeCurrentAgentModelMenu();
    return;
  }

  closeCurrentAgentModelMenu();
  const error = await switchQwenModel(agent, modelName);
  if (error) {
    showError(`模型切换失败：${error}`);
    return;
  }
  showSuccess(`已切换模型：${modelName}`);
}

// ── Think Mode ─────────────────────────────────────────────────────────────────

export async function toggleCurrentAgentThink() {
  const agent = state.currentAgentId
    ? state.agents.find((item) => item.id === state.currentAgentId)
    : null;
  if (!agent || agent.status !== 'connected') {
    return;
  }
  if (state.thinkSwitchingAgentId === agent.id) {
    return;
  }
  if (getThinkSupportByModel(agent.selectedModel) === 'unsupported') {
    showError('当前模型不支持思考模式');
    return;
  }

  const nextEnabled = !Boolean(agent.thinkEnabled);
  state.thinkSwitchingAgentId = agent.id;
  updateCurrentAgentThinkUI();

  try {
    await tauriToggleAgentThink(agent.id, nextEnabled, 'think');
    setThinkSupportByModel(agent.selectedModel, 'supported');
    agent.thinkEnabled = nextEnabled;
    await saveAgents();
    showSuccess(`思考模式已${nextEnabled ? '开启' : '关闭'}`);
  } catch (error) {
    const errorMessage = readErrorMessage(error);
    console.error('Think toggle error:', errorMessage);
    if (isThinkUnsupportedError(error)) {
      setThinkSupportByModel(agent.selectedModel, 'unsupported');
      agent.thinkEnabled = false;
      await saveAgents();
      showError('当前模型不支持思考模式');
    } else {
      showError(`切换思考模式失败: ${errorMessage}`);
    }
  } finally {
    state.thinkSwitchingAgentId = null;
    updateCurrentAgentThinkUI();
  }
}

// ── Slash Command Parsing ─────────────────────────────────────────────────────

export function parseModelSlashCommand(content: string): ParsedModelSlashCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  if (command !== '/model') {
    return null;
  }

  if (parts.length === 1) {
    return { kind: 'help' };
  }

  const subCommand = parts[1].toLowerCase();
  if (subCommand === 'list') {
    const filterKeyword = parts.slice(2).join(' ').trim();
    return {
      kind: 'help',
      filterKeyword: filterKeyword.length > 0 ? filterKeyword : undefined,
    };
  }

  if (subCommand === 'current') {
    return { kind: 'current' };
  }

  const targetModel = parts.slice(1).join(' ').trim();
  if (!targetModel) {
    return { kind: 'help' };
  }

  return {
    kind: 'switch',
    targetModel,
  };
}

// ── Local Command Handler ─────────────────────────────────────────────────────

export async function handleLocalModelCommand(
  content: string,
  agentId: string,
  sessionId: string
): Promise<boolean> {
  const command = parseModelSlashCommand(content);
  if (!command) {
    return false;
  }

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    showError('当前 Agent 不存在');
    return true;
  }

  const sessionMessages = getMessagesForSession(sessionId);
  const userMessage: Message = {
    id: `msg-${Date.now()}-model-user`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  sessionMessages.push(userMessage);
  commitSessionMessages(sessionId, sessionMessages);

  const modelOptions =
    command.kind === 'current'
      ? state.modelOptionsCacheByAgent[agent.id] || []
      : await loadAgentModelOptions(agent, false);

  if (command.kind === 'help') {
    const listText =
      modelOptions.length > 0
        ? formatModelList(modelOptions, command.filterKeyword)
        : '⚠ 当前尚未收到 Qwen 模型列表。\n你仍可使用 /model <模型名> 直接切换。';
    const helpMessage: Message = {
      id: `msg-${Date.now()}-model-help`,
      role: 'system',
      content: `${listText}\n\n当前模型（客户端记录）：${currentAgentModelLabel(agent)}`,
      timestamp: new Date(),
    };
    sessionMessages.push(helpMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  if (command.kind === 'current') {
    const currentMessage: Message = {
      id: `msg-${Date.now()}-model-current`,
      role: 'system',
      content: `🧩 当前模型（客户端记录）：${currentAgentModelLabel(agent)}\n\n说明：自然语言询问"你是什么模型"可能不可靠。\n如需核验，请发送 /about，返回 JSON 中的 modelVersion 会自动同步到这里。`,
      timestamp: new Date(),
    };
    sessionMessages.push(currentMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  const resolved = resolveModelName(command.targetModel || '', modelOptions);
  if (!resolved.modelName) {
    const invalidMessage: Message = {
      id: `msg-${Date.now()}-model-invalid`,
      role: 'system',
      content: resolved.invalidIndex
        ? modelOptions.length > 0
          ? `⚠ 模型编号超出范围。\n\n${formatModelList(modelOptions)}`
          : '⚠ 当前无法使用编号切换模型，因为模型列表暂不可用。\n请改用：/model <模型名>'
        : modelOptions.length > 0
          ? `⚠ 无效模型参数。\n\n${formatModelList(modelOptions)}`
          : '⚠ 无效模型参数。\n请使用：/model <模型名>',
      timestamp: new Date(),
    };
    sessionMessages.push(invalidMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  const modelName = resolved.modelName;
  const progressMessage: Message = {
    id: `msg-${Date.now()}-model-progress`,
    role: 'system',
    content: `🔄 正在切换模型到 ${modelName}...`,
    timestamp: new Date(),
  };
  sessionMessages.push(progressMessage);
  commitSessionMessages(sessionId, sessionMessages);

  const switchError = await switchQwenModel(agent, modelName);
  if (!switchError) {
    progressMessage.content = `✅ 已切换到模型：${modelName}`;
    if (resolved.fromIndex) {
      progressMessage.content += '（通过编号选择）';
    }
    if (resolved.fromAlias) {
      progressMessage.content += '（通过显示名匹配）';
    }
    progressMessage.content += '\n可发送 /model current 查看客户端记录，或发送 /about 核验服务端实际模型。';
    progressMessage.timestamp = new Date();
    commitSessionMessages(sessionId, sessionMessages);
  } else {
    progressMessage.content = `❌ 模型切换失败：${switchError}`;
    progressMessage.timestamp = new Date();
    commitSessionMessages(sessionId, sessionMessages);
  }

  return true;
}

export { currentAgentModelLabel };

// ── About Payload Parsing ─────────────────────────────────────────────────────

export function parseAboutPayload(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const parseCandidate = (candidate: string): Record<string, unknown> | null => {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
      return null;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const parsedType = (parsed as Record<string, unknown>).type;
      if (typeof parsedType !== 'string' || parsedType.toLowerCase() !== 'about') {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fromFence = parseCandidate(fenced[1].trim());
    if (fromFence) {
      return fromFence;
    }
  }

  const inlineObject = trimmed.match(/\{[\s\S]*\}/);
  if (inlineObject?.[0]) {
    return parseCandidate(inlineObject[0].trim());
  }

  return null;
}

export function extractModelNameFromAboutPayload(payload: Record<string, unknown>): string | null {
  const candidateFields = [payload.modelVersion, payload.model, payload.modelName];
  for (const field of candidateFields) {
    if (typeof field === 'string') {
      const normalized = field.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return null;
}

export function syncAgentModelFromAboutContent(agentId: string, content: string) {
  const aboutPayload = parseAboutPayload(content);
  if (!aboutPayload) {
    return;
  }

  const detectedModel = extractModelNameFromAboutPayload(aboutPayload);
  if (!detectedModel) {
    return;
  }

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent || agent.selectedModel === detectedModel) {
    return;
  }

  agent.selectedModel = detectedModel;
  void saveAgents();
  renderAgentList();
  if (state.currentAgentId === agentId) {
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
  }
}
