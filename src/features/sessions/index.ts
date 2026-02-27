// src/features/sessions/index.ts — session management, history sync, and title generation
import {
  clearIflowHistorySessions,
  listIflowHistorySessions,
  loadIflowHistoryMessages,
  deleteIflowHistorySession,
} from '../../services/tauri';
import { escapeHtml } from '../../lib/html';
import { normalizeTitleSource } from '../../lib/markdown';
import { formatSessionMeta } from '../../lib/utils';
import type { Agent, Session, Message, IflowHistoryMessageRecord } from '../../types';
import { state } from '../../store';
import { sessionListEl } from '../../dom';
import {
  buildHistorySessionLocalId,
  inferLegacyHistorySessionId,
  isIflowHistorySessionId,
  dedupeSessionsByIdentity,
  createSession,
  saveSessions,
  saveSessionMessages,
} from '../storage';

// ── Title generation constants ────────────────────────────────────────────────

const TITLE_GENERIC_PHRASES = new Set<string>([
  '继续',
  '好的',
  '谢谢',
  '请继续',
  '帮我',
  '请帮我',
  '开始',
  'ok',
  'okay',
  'thanks',
]);

// ── Session ACP binding ───────────────────────────────────────────────────────

export function applyAcpSessionBinding(agentId: string, acpSessionId: string) {
  const normalizedSessionId = acpSessionId.trim();
  if (!normalizedSessionId) {
    return;
  }

  const preferredSessionId =
    state.inflightSessionByAgent[agentId] ||
    (agentId === state.currentAgentId && state.currentSessionId ? state.currentSessionId : null);
  const sessionList = state.sessionsByAgent[agentId] || [];

  let targetSession = preferredSessionId
    ? sessionList.find((item) => item.id === preferredSessionId)
    : null;
  if (!targetSession) {
    targetSession = sessionList.find((item) => item.acpSessionId === normalizedSessionId) || null;
  }
  if (!targetSession) {
    return;
  }

  // iFlow 历史会话的 sessionId 绑定到磁盘日志文件名，不应被运行时 ACP session 覆盖。
  if (targetSession.source === 'iflow-log') {
    return;
  }

  if (targetSession.acpSessionId === normalizedSessionId) {
    return;
  }

  targetSession.acpSessionId = normalizedSessionId;
  if (!targetSession.source) {
    targetSession.source = 'local';
  }
  void saveSessions();
  if (targetSession.agentId === state.currentAgentId) {
    renderSessionList();
  }
}

// ── Session UI event handlers ─────────────────────────────────────────────────

export function onSessionListClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const actionBtn = target.closest('button[data-action]') as HTMLButtonElement | null;
  if (actionBtn) {
    event.stopPropagation();
    const action = actionBtn.dataset.action;
    const sessionId = actionBtn.dataset.sessionId;
    if (!sessionId) {
      return;
    }
    if (action === 'delete-session') {
      void deleteSession(sessionId);
      return;
    }
  }

  const sessionItem = target.closest('.session-item[data-session-id]') as HTMLDivElement | null;
  if (!sessionItem?.dataset.sessionId) {
    return;
  }
  selectSession(sessionItem.dataset.sessionId);
}

export async function clearCurrentAgentSessions() {
  const { showError } = await import('../app');
  if (!state.currentAgentId) {
    showError('请先选择一个 Agent');
    return;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  if (!agent) {
    showError('当前 Agent 不存在');
    return;
  }
  if (!confirm(`确定要清除当前 Agent（${agent.workspacePath}）的所有会话记录吗？`)) {
    return;
  }

  try {
    await clearIflowHistorySessions(agent.workspacePath);
  } catch (error) {
    console.error('Clear iFlow history sessions error:', error);
    showError(`清除磁盘历史记录失败: ${String(error)}`);
    return;
  }

  const removedSessions = state.sessionsByAgent[state.currentAgentId] || [];
  for (const session of removedSessions) {
    delete state.messagesBySession[session.id];
  }
  state.sessionsByAgent[state.currentAgentId] = [];
  state.currentSessionId = null;
  state.messages = [];
  delete state.inflightSessionByAgent[state.currentAgentId];

  const { clearArtifactPreviewCacheForAgent, closeArtifactPreviewModal, renderMessages, refreshComposerState } = await import('../app');
  clearArtifactPreviewCacheForAgent(state.currentAgentId);
  closeArtifactPreviewModal();

  ensureAgentHasSessions(state.currentAgentId);
  const nextSessions = getSessionsForAgent(state.currentAgentId);
  if (nextSessions.length > 0) {
    state.currentSessionId = nextSessions[0].id;
    state.messages = getMessagesForSession(state.currentSessionId);
  }

  await saveSessions();
  await saveSessionMessages();

  renderSessionList();
  renderMessages();
  refreshComposerState();
}

// ── Session list rendering ────────────────────────────────────────────────────

export function renderSessionList() {
  if (!state.currentAgentId) {
    sessionListEl.innerHTML = '<div class="session-empty">选择 Agent 后显示会话历史</div>';
    return;
  }

  const sessionList = getSessionsForAgent(state.currentAgentId);
  if (sessionList.length === 0) {
    sessionListEl.innerHTML = '<div class="session-empty">暂无会话，点击右上角「新建会话」</div>';
    return;
  }

  sessionListEl.innerHTML = sessionList
    .map((session) => {
      const loadedCount = (state.messagesBySession[session.id] || []).length;
      const messageCount = loadedCount > 0 ? loadedCount : session.messageCountHint || 0;
      return `
      <div class="session-item ${session.id === state.currentSessionId ? 'active' : ''}" data-session-id="${session.id}">
        <div class="session-row">
          <div class="session-title">${escapeHtml(session.title)}</div>
          <button class="btn-session-delete" data-action="delete-session" data-session-id="${session.id}" title="删除会话">×</button>
        </div>
        <div class="session-meta">${escapeHtml(formatSessionMeta(session.updatedAt, messageCount))}</div>
      </div>
    `;
    })
    .join('');
}

export async function deleteSession(sessionId: string) {
  const { showError, renderMessages, refreshComposerState } = await import('../app');
  if (!state.currentAgentId) {
    return;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  if (!agent) {
    return;
  }

  if (state.inflightSessionByAgent[state.currentAgentId] === sessionId) {
    showError('该会话正在回复中，暂时无法删除');
    return;
  }

  const currentSessions = state.sessionsByAgent[state.currentAgentId] || [];
  const targetSession = currentSessions.find((session) => session.id === sessionId);
  if (!targetSession) {
    return;
  }
  if (targetSession.source === 'iflow-log' && !targetSession.acpSessionId) {
    showError('历史会话缺少 sessionId，无法删除磁盘记录');
    return;
  }

  if (targetSession.acpSessionId) {
    try {
      const deleted = await deleteIflowHistorySession(agent.workspacePath, targetSession.acpSessionId);
      if (targetSession.source === 'iflow-log' && !deleted) {
        showError('未找到对应历史会话文件，未执行删除');
        return;
      }
    } catch (error) {
      console.error('Delete iFlow history session error:', error);
      showError(`删除磁盘历史记录失败: ${String(error)}`);
      return;
    }
  }

  state.sessionsByAgent[state.currentAgentId] = currentSessions.filter((session) => session.id !== sessionId);
  delete state.messagesBySession[sessionId];

  if (state.sessionsByAgent[state.currentAgentId].length === 0) {
    const fallback = createSession(state.currentAgentId, '默认会话');
    state.sessionsByAgent[state.currentAgentId].push(fallback);
    state.messagesBySession[fallback.id] = [];
  }

  const ordered = getSessionsForAgent(state.currentAgentId);
  const nextSessionId = ordered[0]?.id || null;

  if (state.currentSessionId === sessionId) {
    state.currentSessionId = null;
    state.messages = [];
    if (nextSessionId) {
      selectSession(nextSessionId);
    } else {
      renderMessages();
    }
  } else {
    renderSessionList();
  }

  await saveSessions();
  await saveSessionMessages();
  refreshComposerState();
}

// ── Session commit / messages ─────────────────────────────────────────────────

export function commitSessionMessages(sessionId: string, sessionMessages: Message[]) {
  state.messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId, sessionMessages);
  void saveSessionMessages();

  if (sessionId === state.currentSessionId) {
    state.messages = sessionMessages;
    void import('../app').then(({ renderMessages, scrollToBottom }) => {
      renderMessages();
      scrollToBottom();
    });
  } else {
    renderSessionList();
  }
}

// ── Session navigation ────────────────────────────────────────────────────────

export function startNewSession() {
  if (!state.currentAgentId) {
    return;
  }

  const index = (state.sessionsByAgent[state.currentAgentId]?.length || 0) + 1;
  const session = createSession(state.currentAgentId, `会话 ${index}`);

  if (!state.sessionsByAgent[state.currentAgentId]) {
    state.sessionsByAgent[state.currentAgentId] = [];
  }
  state.sessionsByAgent[state.currentAgentId].push(session);
  state.messagesBySession[session.id] = [];

  state.currentSessionId = session.id;
  state.messages = [];

  void saveSessions();
  void saveSessionMessages();
  renderSessionList();
  void import('../app').then(({ renderMessages, refreshComposerState }) => {
    renderMessages();
    refreshComposerState();
  });
}

// 清空当前会话
export function clearChat() {
  if (!state.currentSessionId) {
    return;
  }

  state.messages = [];
  state.messagesBySession[state.currentSessionId] = [];
  touchCurrentSession();
  void import('../app').then(({ renderMessages, refreshComposerState }) => {
    renderMessages();
    renderSessionList();
    refreshComposerState();
  });
}

export function selectSession(sessionId: string) {
  if (!state.currentAgentId) {
    return;
  }

  const session = (state.sessionsByAgent[state.currentAgentId] || []).find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  state.currentSessionId = sessionId;
  const cachedMessages = getMessagesForSession(sessionId);
  state.messages = cachedMessages;
  if (session.source === 'iflow-log' && cachedMessages.length === 0) {
    state.messages = [
      {
        id: `msg-${Date.now()}-history-loading`,
        role: 'system',
        content: '正在加载 iFlow 历史会话内容...',
        timestamp: new Date(),
      },
    ];
    void loadIflowHistoryMessagesForSession(session);
  }
  renderSessionList();
  void import('../app').then(({ renderMessages, scrollToBottom, refreshComposerState }) => {
    renderMessages();
    scrollToBottom();
    refreshComposerState();
  });
}

// ── Session queries / mutations ───────────────────────────────────────────────

export function ensureAgentHasSessions(agentId: string) {
  if (!state.sessionsByAgent[agentId]) {
    state.sessionsByAgent[agentId] = [];
  }
  if (state.sessionsByAgent[agentId].length > 0) {
    return;
  }

  const session = createSession(agentId, '默认会话');
  state.sessionsByAgent[agentId] = [session];
  state.messagesBySession[session.id] = [];
}

export function getSessionsForAgent(agentId: string): Session[] {
  return [...(state.sessionsByAgent[agentId] || [])].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
}

export function getMessagesForSession(sessionId: string): Message[] {
  return (state.messagesBySession[sessionId] || []).map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

export function findSessionById(sessionId: string): Session | null {
  for (const sessionList of Object.values(state.sessionsByAgent)) {
    const matched = sessionList.find((item) => item.id === sessionId);
    if (matched) {
      return matched;
    }
  }
  return null;
}

export function touchCurrentSession() {
  if (!state.currentAgentId || !state.currentSessionId) {
    return;
  }
  const session = (state.sessionsByAgent[state.currentAgentId] || []).find((item) => item.id === state.currentSessionId);
  if (!session) {
    return;
  }
  session.updatedAt = new Date();

  void saveSessions();
  renderSessionList();
}

export function touchSessionById(sessionId: string, sessionMessages?: Message[]) {
  for (const sessionList of Object.values(state.sessionsByAgent)) {
    const session = sessionList.find((item) => item.id === sessionId);
    if (!session) {
      continue;
    }
    maybeGenerateSessionTitle(session, sessionMessages ?? getMessagesForSession(sessionId));
    session.updatedAt = new Date();
    void saveSessions();
    return;
  }
}

// ── Session title generation ──────────────────────────────────────────────────

export function maybeGenerateSessionTitle(session: Session, sessionMessages: Message[]) {
  const dialoguePair = getLatestDialoguePair(sessionMessages);
  if (!dialoguePair) {
    return;
  }

  const nextTitle = makeSessionTitleFromDialogue(
    dialoguePair.userMessage.content,
    dialoguePair.assistantMessage.content
  );
  if (nextTitle === session.title) {
    return;
  }
  session.title = nextTitle;
}

export function makeSessionTitleFromDialogue(userContent: string, assistantContent: string): string {
  const normalizedUser = normalizeTitleSource(userContent);
  const normalizedAssistant = normalizeTitleSource(assistantContent);

  const userPhrases = extractTitlePhrases(normalizedUser);
  const assistantPhrases = extractTitlePhrases(normalizedAssistant);
  const keywordTitle = composeKeywordTitle(userPhrases, assistantPhrases);

  if (keywordTitle) {
    return makeSessionTitle(keywordTitle);
  }

  const fallbackTitle = userPhrases[0] || assistantPhrases[0] || normalizedUser || normalizedAssistant || '新会话';
  return makeSessionTitle(fallbackTitle);
}

export function getLatestDialoguePair(
  sessionMessages: Message[]
): { userMessage: Message; assistantMessage: Message } | null {
  let latestUserIndex = -1;
  for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
    const message = sessionMessages[i];
    if (message.role === 'user' && Boolean(message.content.trim())) {
      latestUserIndex = i;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return null;
  }

  let latestAssistantMessage: Message | null = null;
  for (let i = sessionMessages.length - 1; i > latestUserIndex; i -= 1) {
    const message = sessionMessages[i];
    if (message.role === 'assistant' && Boolean(message.content.trim())) {
      latestAssistantMessage = message;
      break;
    }
  }

  if (!latestAssistantMessage) {
    return null;
  }

  return {
    userMessage: sessionMessages[latestUserIndex],
    assistantMessage: latestAssistantMessage,
  };
}

export function composeKeywordTitle(userPhrases: string[], assistantPhrases: string[]): string {
  const keywords: string[] = [];

  for (const phrase of userPhrases) {
    appendTitleKeyword(keywords, phrase);
    if (keywords.length >= 2) {
      return keywords.join(' · ');
    }
  }

  for (const phrase of assistantPhrases) {
    appendTitleKeyword(keywords, phrase);
    if (keywords.length >= 2) {
      return keywords.join(' · ');
    }
  }

  return keywords.join(' · ');
}

export function appendTitleKeyword(target: string[], phrase: string) {
  const keyword = toTitleKeyword(phrase);
  if (!keyword || target.includes(keyword)) {
    return;
  }
  target.push(keyword);
}

export function toTitleKeyword(phrase: string): string {
  const cleaned = normalizeTitleSource(
    phrase
      .replace(
        /^(请问|请|帮我|麻烦|我想|我需要|我希望|我打算|可以|能否|请你|帮忙|让我|想要|我要|现在|先|再|继续)\s*/g,
        ''
      )
      .replace(/^(please|could you|can you|help me|i want to|i need to)\s+/i, '')
      .replace(/\b(please|help|could|would|can|you|me|i|to|the|a|an)\b/gi, ' ')
      .replace(/(一下|一下子|一下吧|一下哈|一下呢)$/g, '')
  );

  if (!cleaned) {
    return '';
  }

  const lowercase = cleaned.toLowerCase();
  if (TITLE_GENERIC_PHRASES.has(cleaned) || TITLE_GENERIC_PHRASES.has(lowercase)) {
    return '';
  }

  if (!isInformativeTitlePhrase(cleaned)) {
    return '';
  }

  return cleaned;
}

export function isInformativeTitlePhrase(phrase: string): boolean {
  const chineseChars = phrase.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseChars.length >= 2) {
    return true;
  }

  const englishWords = phrase.match(/[a-zA-Z0-9_-]{3,}/g) || [];
  return englishWords.length > 0;
}

export function extractTitlePhrases(content: string): string[] {
  if (!content) {
    return [];
  }

  const normalized = normalizeTitleSource(content).replace(/[`*_>#~[\]()]/g, ' ');
  if (!normalized) {
    return [];
  }

  const sentenceParts = normalized
    .split(/[。！？!?；;，,\n\r]/)
    .map((part) => normalizeTitleSource(part))
    .filter((part) => Boolean(part));

  const phrases: string[] = [];
  for (const sentence of sentenceParts) {
    const fragments = sentence
      .split(/(?:并且|而且|以及|然后|同时|另外|还有| and | then )/i)
      .map((fragment) => normalizeTitleSource(fragment))
      .filter((fragment) => Boolean(fragment));

    for (const fragment of fragments) {
      if (phrases.includes(fragment)) {
        continue;
      }
      phrases.push(fragment);
      if (phrases.length >= 6) {
        return phrases;
      }
    }
  }

  return phrases;
}

export function makeSessionTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '新会话';
  }
  if (oneLine.length <= 18) {
    return oneLine;
  }
  return `${oneLine.slice(0, 18)}...`;
}

// ── iFlow history parsing helpers ─────────────────────────────────────────────

export function parseDateOrNow(raw: string | Date): Date {
  if (raw instanceof Date) {
    return raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function splitThinkTaggedContent(rawContent: string): { thoughts: string[]; answer: string } {
  const thoughts: string[] = [];
  const thinkTagPattern = /<\s*think\s*>([\s\S]*?)<\s*\/\s*think\s*>/gi;

  const answer = rawContent
    .replace(thinkTagPattern, (_full, thinkPart: string) => {
      const thought = String(thinkPart || '').trim();
      if (thought) {
        thoughts.push(thought);
      }
      return '\n';
    })
    .trim();

  return { thoughts, answer };
}

export function expandIflowHistoryMessageRecord(item: IflowHistoryMessageRecord): Message[] {
  const baseTimestamp = parseDateOrNow(item.timestamp);
  const baseId = String(item.id || '').trim() || `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = String(item.content || '').trim();
  if (!content) {
    return [];
  }

  if (item.role === 'user') {
    return [
      {
        id: baseId,
        role: 'user',
        content,
        timestamp: baseTimestamp,
      },
    ];
  }

  const { thoughts, answer } = splitThinkTaggedContent(content);
  const expanded: Message[] = thoughts.map((thought, index) => ({
    id: `${baseId}-think-${index}`,
    role: 'thought',
    content: thought,
    timestamp: baseTimestamp,
  }));

  if (answer) {
    expanded.push({
      id: baseId,
      role: 'assistant',
      content: answer,
      timestamp: baseTimestamp,
    });
  } else if (expanded.length === 0) {
    expanded.push({
      id: baseId,
      role: 'assistant',
      content,
      timestamp: baseTimestamp,
    });
  }

  return expanded;
}

// ── iFlow history sync ────────────────────────────────────────────────────────

export async function syncIflowHistorySessions(agent: Agent): Promise<void> {
  if (agent.status !== 'connected') {
    return;
  }

  try {
    const histories = await listIflowHistorySessions(agent.workspacePath);
    const historyList = Array.isArray(histories) ? histories : [];

    ensureAgentHasSessions(agent.id);
    const sessionList = state.sessionsByAgent[agent.id] || [];
    let changed = false;
    let messagesChanged = false;
    const liveHistorySessionIds = new Set<string>();

    for (const history of historyList) {
      const acpSessionId = String(history.sessionId || '').trim();
      if (!acpSessionId) {
        continue;
      }
      liveHistorySessionIds.add(acpSessionId);

      const expectedHistorySessionId = buildHistorySessionLocalId(agent.id, acpSessionId);
      const existing = sessionList.find(
        (item) => item.acpSessionId === acpSessionId || item.id === expectedHistorySessionId
      );
      if (existing) {
        if (
          !existing.acpSessionId ||
          (existing.source === 'iflow-log' && !isIflowHistorySessionId(existing.acpSessionId))
        ) {
          existing.acpSessionId = acpSessionId;
          changed = true;
        }
        if (existing.source !== 'iflow-log' && existing.id === expectedHistorySessionId) {
          existing.source = 'iflow-log';
          changed = true;
        }
        const nextUpdatedAt = parseDateOrNow(history.updatedAt);
        if (nextUpdatedAt.getTime() > existing.updatedAt.getTime()) {
          existing.updatedAt = nextUpdatedAt;
          changed = true;
        }
        if (existing.source === 'iflow-log' && history.title && existing.title !== history.title) {
          existing.title = history.title;
          changed = true;
        }
        if (
          typeof history.messageCount === 'number' &&
          history.messageCount >= 0 &&
          existing.messageCountHint !== history.messageCount
        ) {
          existing.messageCountHint = history.messageCount;
          changed = true;
        }
        continue;
      }

      const imported: Session = {
        id: buildHistorySessionLocalId(agent.id, acpSessionId),
        agentId: agent.id,
        title: (history.title || acpSessionId).trim(),
        createdAt: parseDateOrNow(history.createdAt),
        updatedAt: parseDateOrNow(history.updatedAt),
        acpSessionId,
        source: 'iflow-log',
        messageCountHint:
          typeof history.messageCount === 'number' && history.messageCount >= 0
            ? history.messageCount
            : undefined,
      };
      sessionList.push(imported);
      changed = true;
    }

    const staleHistorySessions = sessionList.filter((item) => {
      if (item.source !== 'iflow-log') {
        return false;
      }

      const normalizedSessionId =
        item.acpSessionId?.trim() || inferLegacyHistorySessionId(agent.id, item.id) || '';
      if (!normalizedSessionId) {
        return true;
      }

      return !liveHistorySessionIds.has(normalizedSessionId);
    });
    if (staleHistorySessions.length > 0) {
      const staleSessionIds = new Set(staleHistorySessions.map((item) => item.id));
      state.sessionsByAgent[agent.id] = sessionList.filter((item) => !staleSessionIds.has(item.id));
      for (const staleSession of staleHistorySessions) {
        delete state.messagesBySession[staleSession.id];
      }
      changed = true;
      messagesChanged = true;
    } else {
      state.sessionsByAgent[agent.id] = sessionList;
    }

    const normalizedSessionList = state.sessionsByAgent[agent.id] || [];
    const dedupedSessions = dedupeSessionsByIdentity(normalizedSessionList);
    if (dedupedSessions.length !== normalizedSessionList.length) {
      state.sessionsByAgent[agent.id] = dedupedSessions;
      changed = true;
      const liveIds = new Set(dedupedSessions.map((item) => item.id));
      for (const sessionId of Object.keys(state.messagesBySession)) {
        if (!liveIds.has(sessionId) && sessionId.startsWith(`iflowlog-${agent.id}-`)) {
          delete state.messagesBySession[sessionId];
          messagesChanged = true;
        }
      }
    }

    if ((state.sessionsByAgent[agent.id] || []).length === 0) {
      ensureAgentHasSessions(agent.id);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await saveSessions();
    if (messagesChanged) {
      await saveSessionMessages();
    }

    if (state.currentAgentId === agent.id) {
      const activeSessions = getSessionsForAgent(agent.id);
      const currentStillExists =
        Boolean(state.currentSessionId) && activeSessions.some((item) => item.id === state.currentSessionId);
      if (!currentStillExists) {
        state.currentSessionId = null;
        state.messages = [];
        const fallbackSession = activeSessions[0];
        if (fallbackSession) {
          selectSession(fallbackSession.id);
        } else {
          renderSessionList();
          const { renderMessages, refreshComposerState } = await import('../app');
          renderMessages();
          refreshComposerState();
        }
      } else {
        renderSessionList();
        const { refreshComposerState } = await import('../app');
        refreshComposerState();
      }
    }
  } catch (error) {
    console.error('Sync iFlow history sessions error:', error);
  }
}

export async function loadIflowHistoryMessagesForSession(session: Session): Promise<void> {
  let effectiveSessionId = session.acpSessionId?.trim() || '';
  if (!isIflowHistorySessionId(effectiveSessionId)) {
    const inferred = inferLegacyHistorySessionId(session.agentId, session.id);
    if (inferred && isIflowHistorySessionId(inferred)) {
      effectiveSessionId = inferred;
      if (session.acpSessionId !== inferred) {
        session.acpSessionId = inferred;
        void saveSessions();
        if (state.currentAgentId === session.agentId) {
          renderSessionList();
        }
      }
    }
  }
  if (!isIflowHistorySessionId(effectiveSessionId)) {
    if (state.currentSessionId === session.id) {
      state.messages = [
        {
          id: `msg-${Date.now()}-history-invalid-session-id`,
          role: 'system',
          content: '该历史会话缺少有效的 sessionId，无法加载历史内容',
          timestamp: new Date(),
        },
      ];
      const { renderMessages, refreshComposerState } = await import('../app');
      renderMessages();
      refreshComposerState();
    }
    return;
  }
  const agent = state.agents.find((item) => item.id === session.agentId);
  if (!agent) {
    return;
  }

  try {
    const rawMessages = await loadIflowHistoryMessages(agent.workspacePath, effectiveSessionId);

    const normalized: Message[] = (Array.isArray(rawMessages) ? rawMessages : [])
      .flatMap((item) => expandIflowHistoryMessageRecord(item))
      .filter((item) => item.content.trim().length > 0);

    state.messagesBySession[session.id] = normalized;
    if (session.source === 'iflow-log') {
      session.messageCountHint = normalized.filter(
        (item) => item.role === 'user' || item.role === 'assistant'
      ).length;
    }

    const { renderMessages, scrollToBottom, refreshComposerState } = await import('../app');
    if (state.currentSessionId === session.id) {
      state.messages = normalized;
      renderMessages();
      scrollToBottom();
      refreshComposerState();
    } else {
      renderSessionList();
    }
  } catch (error) {
    console.error('Load iFlow history messages error:', error);
    const detail = String(error);
    const isMissingHistoryFile =
      session.source === 'iflow-log' && detail.includes('Session file not found for');

    if (isMissingHistoryFile) {
      const scopedSessions = state.sessionsByAgent[session.agentId] || [];
      const filtered = scopedSessions.filter((item) => item.id !== session.id);
      if (filtered.length !== scopedSessions.length) {
        state.sessionsByAgent[session.agentId] = filtered;
        delete state.messagesBySession[session.id];

        if (state.sessionsByAgent[session.agentId].length === 0) {
          const fallback = createSession(session.agentId, '默认会话');
          state.sessionsByAgent[session.agentId].push(fallback);
          state.messagesBySession[fallback.id] = [];
        }

        await saveSessions();
        await saveSessionMessages();
      }

      const { renderMessages, refreshComposerState, showError } = await import('../app');
      if (state.currentAgentId === session.agentId) {
        const scoped = getSessionsForAgent(session.agentId);
        const currentStillExists =
          Boolean(state.currentSessionId) && scoped.some((item) => item.id === state.currentSessionId);
        if (!currentStillExists) {
          state.currentSessionId = null;
          state.messages = [];
          const fallbackSession = scoped[0];
          if (fallbackSession) {
            selectSession(fallbackSession.id);
          } else {
            renderSessionList();
            renderMessages();
            refreshComposerState();
          }
        } else {
          renderSessionList();
        }
      }

      showError('该历史会话文件已不存在，已从列表移除');
      return;
    }

    if (state.currentSessionId === session.id) {
      const { renderMessages, refreshComposerState, showError } = await import('../app');
      state.messages = [
        {
          id: `msg-${Date.now()}-history-load-failed`,
          role: 'system',
          content: `加载历史会话失败：${detail}`,
          timestamp: new Date(),
        },
      ];
      renderMessages();
      refreshComposerState();
      showError(`加载历史会话失败: ${detail}`);
    }
  }
}
