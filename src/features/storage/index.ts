// src/features/storage/index.ts — storage, serialization, and session utilities
import {
  loadStorageSnapshot as tauriLoadStorageSnapshot,
  saveStorageSnapshot as tauriSaveStorageSnapshot,
} from '../../services/tauri';
import { generateAcpSessionId, normalizeStoredRole } from '../../lib/utils';
import type { Session, Message, StoredSession, StoredMessage, StoredSessionMap, StoredMessageMap, LegacyMessageHistoryMap, StorageSnapshot } from '../../types';
import { state } from '../../store';

// ── Storage keys ──────────────────────────────────────────────────────────────
export const AGENTS_STORAGE_KEY = 'iflow-agents';
export const SESSIONS_STORAGE_KEY = 'iflow-sessions';
export const SESSION_MESSAGES_STORAGE_KEY = 'iflow-session-messages';
export const LEGACY_MESSAGE_HISTORY_STORAGE_KEY = 'iflow-message-history';

// ── Session identity utilities ────────────────────────────────────────────────

export function buildHistorySessionLocalId(agentId: string, acpSessionId: string): string {
  return `iflowlog-${agentId}-${acpSessionId}`;
}

export function inferLegacyHistorySessionId(agentId: string, sessionId: string): string | null {
  const prefix = `iflowlog-${agentId}-`;
  if (!sessionId.startsWith(prefix)) {
    return null;
  }
  const candidate = sessionId.slice(prefix.length).trim();
  if (!candidate.startsWith('session-')) {
    return null;
  }
  return candidate;
}

export function isIflowHistorySessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId && sessionId.trim().startsWith('session-'));
}

export function dedupeSessionsByIdentity(sessionList: Session[]): Session[] {
  const ordered = [...sessionList].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const deduped: Session[] = [];
  const seen = new Set<string>();

  for (const session of ordered) {
    const acpKey =
      typeof session.acpSessionId === 'string' && session.acpSessionId.trim().length > 0
        ? `acp:${session.acpSessionId.trim()}`
        : null;
    const key = acpKey || `id:${session.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(session);
  }

  return deduped;
}

// ── Session factory ───────────────────────────────────────────────────────────

export function createSession(agentId: string, title = '新会话'): Session {
  const now = new Date();
  return {
    id: `sess-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    agentId,
    title,
    createdAt: now,
    updatedAt: now,
    acpSessionId: generateAcpSessionId(),
    source: 'local',
  };
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function parseStoredSession(session: StoredSession): Session {
  const normalizedTitle =
    typeof session.title === 'string' && session.title.trim().length > 0
      ? session.title
      : '新会话';
  const rawAcpSessionId =
    typeof session.acpSessionId === 'string' && session.acpSessionId.trim().length > 0
      ? session.acpSessionId.trim()
      : undefined;
  const inferredAcpSessionId = inferLegacyHistorySessionId(session.agentId, session.id) || undefined;
  const normalizedAcpSessionId =
    session.source === 'iflow-log'
      ? isIflowHistorySessionId(rawAcpSessionId)
        ? rawAcpSessionId
        : inferredAcpSessionId
      : rawAcpSessionId || inferredAcpSessionId;
  const normalizedSource =
    session.source === 'iflow-log'
      ? 'iflow-log'
      : normalizedAcpSessionId && session.id === buildHistorySessionLocalId(session.agentId, normalizedAcpSessionId)
        ? 'iflow-log'
        : 'local';

  return {
    ...session,
    title: normalizedTitle,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    acpSessionId: normalizedAcpSessionId,
    source: normalizedSource,
    messageCountHint:
      typeof session.messageCountHint === 'number' && session.messageCountHint >= 0
        ? session.messageCountHint
        : undefined,
  };
}

export function toStoredSession(session: Session): StoredSession {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    acpSessionId: session.acpSessionId,
    source: session.source || 'local',
    messageCountHint: session.messageCountHint,
  };
}

export function parseStoredMessage(message: StoredMessage): Message {
  return {
    ...message,
    role: normalizeStoredRole(message.role),
    timestamp: new Date(message.timestamp),
  };
}

export function toStoredMessage(message: Message): StoredMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

// ── Snapshot building ─────────────────────────────────────────────────────────

export function buildStoredSessionMap(): StoredSessionMap {
  const payload: StoredSessionMap = {};
  for (const [agentId, sessionList] of Object.entries(state.sessionsByAgent)) {
    payload[agentId] = sessionList.map(toStoredSession);
  }
  return payload;
}

export function buildStoredMessageMap(): StoredMessageMap {
  const payload: StoredMessageMap = {};
  for (const [sessionId, sessionMessages] of Object.entries(state.messagesBySession)) {
    // Skip iflow-log sessions (not persisted locally)
    const session = findSessionByIdInState(sessionId);
    if (session?.source === 'iflow-log') {
      continue;
    }
    payload[sessionId] = sessionMessages.map(toStoredMessage);
  }
  return payload;
}

export function buildStorageSnapshot(): StorageSnapshot {
  return {
    sessionsByAgent: buildStoredSessionMap(),
    messagesBySession: buildStoredMessageMap(),
  };
}

export function normalizeStoredSessions(parsed: StoredSessionMap | null | undefined): Record<string, Session[]> {
  const normalized: Record<string, Session[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [agentId, storedSessions] of Object.entries(parsed)) {
    const parsedSessions = Array.isArray(storedSessions) ? storedSessions.map(parseStoredSession) : [];
    normalized[agentId] = dedupeSessionsByIdentity(parsedSessions);
  }
  return normalized;
}

export function normalizeStoredMessages(parsed: StoredMessageMap | null | undefined): Record<string, Message[]> {
  const normalized: Record<string, Message[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [sessionId, storedMessages] of Object.entries(parsed)) {
    normalized[sessionId] = Array.isArray(storedMessages) ? storedMessages.map(parseStoredMessage) : [];
  }
  return normalized;
}

// ── Session lookup (local to this module) ─────────────────────────────────────

function findSessionByIdInState(sessionId: string): Session | null {
  for (const sessionList of Object.values(state.sessionsByAgent)) {
    const matched = sessionList.find((item) => item.id === sessionId);
    if (matched) {
      return matched;
    }
  }
  return null;
}

// ── Persistence: persist current session messages ─────────────────────────────

export function persistCurrentSessionMessages() {
  if (!state.currentSessionId) {
    return;
  }
  const session = findSessionByIdInState(state.currentSessionId);
  if (session?.source === 'iflow-log') {
    return;
  }
  state.messagesBySession[state.currentSessionId] = state.messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
  void saveSessionMessages();
}

// ── Backend / localStorage persistence ───────────────────────────────────────

export function readStorageSnapshotFromLocalStorage(): StorageSnapshot | null {
  const sessionRaw = localStorage.getItem(SESSIONS_STORAGE_KEY);
  const messageRaw = localStorage.getItem(SESSION_MESSAGES_STORAGE_KEY);
  if (!sessionRaw && !messageRaw) {
    return null;
  }

  try {
    const sessionsByAgent = sessionRaw ? (JSON.parse(sessionRaw) as StoredSessionMap) : {};
    const messagesBySession = messageRaw ? (JSON.parse(messageRaw) as StoredMessageMap) : {};
    return {
      sessionsByAgent,
      messagesBySession,
    };
  } catch (e) {
    console.error('Failed to load session storage from localStorage:', e);
    return null;
  }
}

export function clearLocalStorageSessionData() {
  localStorage.removeItem(SESSIONS_STORAGE_KEY);
  localStorage.removeItem(SESSION_MESSAGES_STORAGE_KEY);
}

export async function loadStorageSnapshot(): Promise<StorageSnapshot | null> {
  try {
    const snapshot = await tauriLoadStorageSnapshot();
    if (!snapshot) {
      return null;
    }
    return {
      sessionsByAgent: snapshot.sessionsByAgent || {},
      messagesBySession: snapshot.messagesBySession || {},
    };
  } catch (e) {
    console.error('Failed to load session storage from backend:', e);
    return null;
  }
}

export async function saveStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  try {
    await tauriSaveStorageSnapshot(snapshot);
    return true;
  } catch (e) {
    console.error('Failed to save session storage to backend:', e);
    return false;
  }
}

export async function persistStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  const stored = await saveStorageSnapshot(snapshot);
  if (stored) {
    clearLocalStorageSessionData();
    return true;
  }

  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(snapshot.sessionsByAgent));
    localStorage.setItem(SESSION_MESSAGES_STORAGE_KEY, JSON.stringify(snapshot.messagesBySession));
  } catch (e) {
    console.error('Failed to save session storage to localStorage:', e);
  }
  return false;
}

export function isStorageSnapshotEmpty(snapshot: StorageSnapshot): boolean {
  return (
    Object.keys(snapshot.sessionsByAgent).length === 0 &&
    Object.keys(snapshot.messagesBySession).length === 0
  );
}

export async function loadSessionStore() {
  const backendSnapshot = await loadStorageSnapshot();
  if (backendSnapshot) {
    state.sessionsByAgent = normalizeStoredSessions(backendSnapshot.sessionsByAgent);
    state.messagesBySession = normalizeStoredMessages(backendSnapshot.messagesBySession);

    if (isStorageSnapshotEmpty(backendSnapshot)) {
      const localSnapshot = readStorageSnapshotFromLocalStorage();
      if (localSnapshot) {
        state.sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
        state.messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
        await persistStorageSnapshot(localSnapshot);
      }
    }
    return;
  }

  const localSnapshot = readStorageSnapshotFromLocalStorage();
  if (!localSnapshot) {
    state.sessionsByAgent = {};
    state.messagesBySession = {};
    return;
  }

  state.sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
  state.messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
}

export async function saveSessions() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

export async function saveSessionMessages() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

export async function migrateLegacyHistoryIfNeeded() {
  const legacyRaw = localStorage.getItem(LEGACY_MESSAGE_HISTORY_STORAGE_KEY);
  if (!legacyRaw) {
    return;
  }

  try {
    const parsed = JSON.parse(legacyRaw) as LegacyMessageHistoryMap;
    for (const [agentId, storedMessages] of Object.entries(parsed)) {
      if (!Array.isArray(storedMessages)) {
        continue;
      }
      if (!state.sessionsByAgent[agentId] || state.sessionsByAgent[agentId].length === 0) {
        const migratedSession = createSession(agentId, '历史会话');
        state.sessionsByAgent[agentId] = [migratedSession];
      }

      const targetSession = state.sessionsByAgent[agentId][0];
      const normalizedMessages = storedMessages.map(parseStoredMessage);
      state.messagesBySession[targetSession.id] = normalizedMessages;

      if (normalizedMessages.length > 0) {
        const lastTimestamp = normalizedMessages[normalizedMessages.length - 1].timestamp;
        targetSession.updatedAt = new Date(lastTimestamp);
      }
    }

    localStorage.removeItem(LEGACY_MESSAGE_HISTORY_STORAGE_KEY);
    await saveSessions();
    await saveSessionMessages();
  } catch (e) {
    console.error('Failed to migrate legacy history:', e);
  }
}

export function pruneSessionDataByAgents() {
  const liveAgentIds = new Set(state.agents.map((agent) => agent.id));

  const prunedSessions: Record<string, Session[]> = {};
  for (const [agentId, sessionList] of Object.entries(state.sessionsByAgent)) {
    if (!liveAgentIds.has(agentId)) {
      continue;
    }
    prunedSessions[agentId] = sessionList;
  }
  state.sessionsByAgent = prunedSessions;

  const liveSessionIds = new Set(
    Object.values(state.sessionsByAgent)
      .flat()
      .map((session) => session.id)
  );

  const prunedMessages: Record<string, Message[]> = {};
  for (const [sessionId, sessionMessages] of Object.entries(state.messagesBySession)) {
    if (liveSessionIds.has(sessionId)) {
      prunedMessages[sessionId] = sessionMessages;
    }
  }
  state.messagesBySession = prunedMessages;
}
