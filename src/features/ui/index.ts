// src/features/ui/index.ts — UI rendering, artifact preview, and chat interaction
import {
  convertFileSrc,
  readHtmlArtifact,
  resolveHtmlArtifactPath,
} from '../../services/tauri';
import { formatTime } from '../../lib/utils';
import { escapeHtml } from '../../lib/html';
import { formatMessageContent } from '../../lib/markdown';
import type { ToolCall } from '../../types';
import { state } from '../../store';
import {
  chatMessagesEl,
  artifactPreviewModalEl,
  artifactPreviewPathEl,
  artifactPreviewFrameEl,
  toolCallsPanelEl,
  toolCallsListEl,
} from '../../dom';
import { persistCurrentSessionMessages } from '../storage';
import { showError, isCurrentAgentBusy } from '../agents';
import { canUseConversationQuickAction } from '../app';

// ── Artifact preview constants ────────────────────────────────────────────────

const HTML_ARTIFACT_PATH_PATTERN = /\.html?$/i;
const HTML_ARTIFACT_JSON_PATH_PATTERN =
  /["']?(?:file_path|absolute_path|path)["']?\s*[:=]\s*["']([^"'\n]+\.html?)["']/gi;
const HTML_ARTIFACT_GENERIC_PATH_PATTERN =
  /(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'`<>|]+\.html?/gi;
const HTML_ARTIFACT_BARE_FILE_PATTERN = /[^\s"'`<>|/\\]+\.html?/gi;
const ARTIFACT_PREVIEW_CACHE_LIMIT = 8;
const ARTIFACT_PREVIEW_READ_TIMEOUT_MS = 12000;
const ARTIFACT_PREVIEW_CACHE_URL_PREFIX = 'url:';
const ARTIFACT_PREVIEW_CACHE_HTML_PREFIX = 'html:';

const ASSISTANT_QUICK_REPLIES: ReadonlyArray<string> = ['继续', '好的'];

// ── Artifact path parsing ─────────────────────────────────────────────────────

export function stripArtifactPathPunctuation(token: string): string {
  return token
    .replace(/^[`"'([{<\u300c\u300e\u3010\u3014\u2018\u201c]+/, '')
    .replace(/[`"')\]}>.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u300d\u300f\u3011\u3015\u2019\u201d]+$/, '')
    .trim();
}

export function normalizeArtifactPathInput(raw: string): string {
  let candidate = raw.trim();
  if (/^@(?=\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])/.test(candidate)) {
    candidate = candidate.slice(1);
  }
  return candidate;
}

export function normalizeArtifactPathCandidate(raw: string): string | null {
  let candidate = stripArtifactPathPunctuation(raw);
  if (!candidate) {
    return null;
  }

  candidate = candidate
    .replace(/\\\//g, '/')
    .replace(/^[`"']?(?:file_path|absolute_path|path)[`"']?\s*[:=]\s*/i, '');
  candidate = stripArtifactPathPunctuation(candidate);
  if (!candidate) {
    return null;
  }

  candidate = candidate.replace(/^\[diff\]\s*/i, '').trim();
  if (!candidate) {
    return null;
  }
  candidate = normalizeArtifactPathInput(candidate);
  if (!candidate) {
    return null;
  }

  if (!HTML_ARTIFACT_PATH_PATTERN.test(candidate)) {
    return null;
  }

  if (/^https?:\/\//i.test(candidate)) {
    return null;
  }

  return candidate;
}

export function extractHtmlArtifactPaths(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  const unique = new Set<string>();
  const addCandidate = (value: string) => {
    const normalized = normalizeArtifactPathCandidate(value);
    if (normalized) {
      unique.add(normalized);
    }
  };

  HTML_ARTIFACT_JSON_PATH_PATTERN.lastIndex = 0;
  let jsonMatch = HTML_ARTIFACT_JSON_PATH_PATTERN.exec(text);
  while (jsonMatch) {
    addCandidate(jsonMatch[1]);
    jsonMatch = HTML_ARTIFACT_JSON_PATH_PATTERN.exec(text);
  }

  HTML_ARTIFACT_GENERIC_PATH_PATTERN.lastIndex = 0;
  let genericMatch = HTML_ARTIFACT_GENERIC_PATH_PATTERN.exec(text);
  while (genericMatch) {
    addCandidate(genericMatch[0]);
    genericMatch = HTML_ARTIFACT_GENERIC_PATH_PATTERN.exec(text);
  }

  HTML_ARTIFACT_BARE_FILE_PATTERN.lastIndex = 0;
  let bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
  while (bareMatch) {
    const matchStart = bareMatch.index;
    if (matchStart > 0) {
      const previousChar = text[matchStart - 1];
      if (previousChar === '/' || previousChar === '\\') {
        bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
        continue;
      }
    }
    addCandidate(bareMatch[0]);
    bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
  }

  const markdownLinkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let markdownMatch = markdownLinkPattern.exec(text);
  while (markdownMatch) {
    addCandidate(markdownMatch[1]);
    markdownMatch = markdownLinkPattern.exec(text);
  }

  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    addCandidate(token);
  }

  return Array.from(unique).slice(0, 6);
}

export function artifactFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function renderArtifactPreviewActions(text: string): string {
  const paths = extractHtmlArtifactPaths(text);
  if (paths.length === 0) {
    return '';
  }

  return `
    <div class="artifact-actions">
      ${paths
        .map((path) => {
          const encodedPath = encodeURIComponent(path);
          const title = escapeHtml(path);
          const fileName = escapeHtml(artifactFileName(path));
          return `
            <button
              type="button"
              class="artifact-preview-btn"
              data-artifact-preview-path="${encodedPath}"
              title="${title}"
            >
              预览 HTML · ${fileName}
            </button>
          `;
        })
        .join('')}
    </div>
  `;
}

export function decodeArtifactPath(encodedPath: string): string | null {
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

export function renderArtifactPlaceholder(title: string, description: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; display: grid; place-items: center; min-height: 100vh; }
    .box { padding: 20px 24px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; max-width: 680px; }
    h1 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 0; color: #9ba7b4; line-height: 1.6; font-size: 13px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
  </div>
</body>
</html>`;
}

// ── Artifact preview cache ────────────────────────────────────────────────────

export function buildArtifactPreviewCacheKey(agentId: string, normalizedPath: string): string {
  return `${agentId}::${normalizedPath}`;
}

export function touchArtifactCacheKey(key: string) {
  const existingIndex = state.artifactPreviewCacheOrder.indexOf(key);
  if (existingIndex >= 0) {
    state.artifactPreviewCacheOrder.splice(existingIndex, 1);
  }
  state.artifactPreviewCacheOrder.push(key);
}

export function setArtifactPreviewCache(key: string, html: string) {
  state.artifactPreviewCacheByKey.set(key, html);
  touchArtifactCacheKey(key);

  while (state.artifactPreviewCacheOrder.length > ARTIFACT_PREVIEW_CACHE_LIMIT) {
    const oldestKey = state.artifactPreviewCacheOrder.shift();
    if (!oldestKey) {
      continue;
    }
    state.artifactPreviewCacheByKey.delete(oldestKey);
    if (state.artifactPreviewLastKey === oldestKey) {
      state.artifactPreviewLastKey = null;
    }
  }
}

export function getArtifactPreviewCache(key: string): string | null {
  const payload = state.artifactPreviewCacheByKey.get(key);
  if (!payload) {
    return null;
  }
  touchArtifactCacheKey(key);
  return payload;
}

export function encodeArtifactPreviewCacheEntry(mode: 'url' | 'html', value: string): string {
  return `${mode === 'url' ? ARTIFACT_PREVIEW_CACHE_URL_PREFIX : ARTIFACT_PREVIEW_CACHE_HTML_PREFIX}${value}`;
}

export function decodeArtifactPreviewCacheEntry(payload: string): { mode: 'url' | 'html'; value: string } | null {
  if (payload.startsWith(ARTIFACT_PREVIEW_CACHE_URL_PREFIX)) {
    return {
      mode: 'url',
      value: payload.slice(ARTIFACT_PREVIEW_CACHE_URL_PREFIX.length),
    };
  }
  if (payload.startsWith(ARTIFACT_PREVIEW_CACHE_HTML_PREFIX)) {
    return {
      mode: 'html',
      value: payload.slice(ARTIFACT_PREVIEW_CACHE_HTML_PREFIX.length),
    };
  }
  return null;
}

export function applyArtifactPreviewContent(mode: 'url' | 'html', value: string) {
  if (mode === 'url') {
    artifactPreviewFrameEl.srcdoc = '';
    artifactPreviewFrameEl.src = value;
    return;
  }

  artifactPreviewFrameEl.removeAttribute('src');
  artifactPreviewFrameEl.srcdoc = value;
}

export function createArtifactPreviewTimeoutPromise(): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`读取超时（>${ARTIFACT_PREVIEW_READ_TIMEOUT_MS / 1000}s）`));
    }, ARTIFACT_PREVIEW_READ_TIMEOUT_MS);
  });
}

export function shouldIgnoreArtifactResponse(requestToken: number, expectedPath: string): boolean {
  if (state.artifactPreviewRequestToken === requestToken) {
    return false;
  }
  if (artifactPreviewModalEl.classList.contains('hidden')) {
    return true;
  }
  const currentPath = artifactPreviewPathEl.textContent?.trim() || '';
  return currentPath !== expectedPath;
}

export function clearArtifactPreviewCacheForAgent(agentId: string) {
  const prefix = `${agentId}::`;
  for (const key of Array.from(state.artifactPreviewCacheByKey.keys())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    state.artifactPreviewCacheByKey.delete(key);
    state.artifactPreviewCacheOrder = state.artifactPreviewCacheOrder.filter((item) => item !== key);
    if (state.artifactPreviewLastKey === key) {
      state.artifactPreviewLastKey = null;
    }
  }
}

export function warmUpArtifactPreviewFrame() {
  if (artifactPreviewFrameEl.dataset.warmed === '1') {
    return;
  }
  artifactPreviewFrameEl.srcdoc = renderArtifactPlaceholder('HTML 预览', '预览容器已就绪');
  artifactPreviewFrameEl.dataset.warmed = '1';
}

export function closeArtifactPreviewModal() {
  state.artifactPreviewRequestToken += 1;
  artifactPreviewModalEl.classList.add('hidden');
  artifactPreviewPathEl.textContent = '';
}

export async function openArtifactPreview(path: string) {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent || agent.status !== 'connected') {
    showError('请先连接当前 Agent，再预览 HTML Artifact');
    return;
  }

  const normalizedPath = normalizeArtifactPathInput(path.trim());
  if (!normalizedPath) {
    showError('无效的 Artifact 路径');
    return;
  }

  const cacheKey = buildArtifactPreviewCacheKey(agent.id, normalizedPath);
  artifactPreviewModalEl.classList.remove('hidden');
  artifactPreviewPathEl.textContent = normalizedPath;

  if (state.artifactPreviewLastKey === cacheKey) {
    return;
  }

  const cachedHtml = getArtifactPreviewCache(cacheKey);
  if (cachedHtml) {
    const cachedEntry = decodeArtifactPreviewCacheEntry(cachedHtml);
    if (cachedEntry) {
      applyArtifactPreviewContent(cachedEntry.mode, cachedEntry.value);
      state.artifactPreviewLastKey = cacheKey;
      return;
    }
    state.artifactPreviewCacheByKey.delete(cacheKey);
  }

  applyArtifactPreviewContent(
    'html',
    renderArtifactPlaceholder(
      '正在加载 HTML 预览',
      '正在读取文件内容，请稍候...'
    )
  );

  const requestToken = state.artifactPreviewRequestToken + 1;
  state.artifactPreviewRequestToken = requestToken;
  const hardTimeoutId = window.setTimeout(() => {
    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }
    if (state.artifactPreviewLastKey === cacheKey) {
      return;
    }
    state.artifactPreviewLastKey = null;
    applyArtifactPreviewContent(
      'html',
      renderArtifactPlaceholder(
        'HTML 预览失败',
        `读取超时（>${ARTIFACT_PREVIEW_READ_TIMEOUT_MS / 1000}s）`
      )
    );
  }, ARTIFACT_PREVIEW_READ_TIMEOUT_MS + 1000);

  let readError: unknown = null;
  try {
    const html = await Promise.race([
      readHtmlArtifact(agent.id, normalizedPath),
      createArtifactPreviewTimeoutPromise(),
    ]);

    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }

    setArtifactPreviewCache(cacheKey, encodeArtifactPreviewCacheEntry('html', html));
    state.artifactPreviewLastKey = cacheKey;
    applyArtifactPreviewContent('html', html);
    return;
  } catch (error) {
    readError = error;
  }

  try {
    const absolutePath = await Promise.race([
      resolveHtmlArtifactPath(agent.id, normalizedPath),
      createArtifactPreviewTimeoutPromise(),
    ]);

    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }

    const assetUrl = convertFileSrc(absolutePath);
    setArtifactPreviewCache(cacheKey, encodeArtifactPreviewCacheEntry('url', assetUrl));
    state.artifactPreviewLastKey = cacheKey;
    applyArtifactPreviewContent('url', assetUrl);
  } catch (resolveError) {
    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }
    if (!readError) {
      return;
    }

    state.artifactPreviewLastKey = null;
    const readMessage = readError instanceof Error ? readError.message : String(readError);
    const resolveMessage = resolveError instanceof Error ? resolveError.message : String(resolveError);
    applyArtifactPreviewContent(
      'html',
      renderArtifactPlaceholder(
        'HTML 预览失败',
        `内容读取失败：${readMessage}\nURL 预览失败：${resolveMessage}`
      )
    );
  } finally {
    window.clearTimeout(hardTimeoutId);
  }
}

// ── Chat click handlers ───────────────────────────────────────────────────────

export function onChatMessagesClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const artifactBtn = target.closest('button[data-artifact-preview-path]') as HTMLButtonElement | null;
  if (artifactBtn?.dataset.artifactPreviewPath) {
    const path = decodeArtifactPath(artifactBtn.dataset.artifactPreviewPath);
    if (path) {
      event.preventDefault();
      void openArtifactPreview(path);
    }
    return;
  }

  const quickReplyBtn = target.closest('button[data-quick-reply]') as HTMLButtonElement | null;
  if (quickReplyBtn) {
    const reply = quickReplyBtn.dataset.quickReply;
    if (!reply) {
      return;
    }

    event.preventDefault();
    void import('../app').then(({ sendQuickReply }) => {
      void sendQuickReply(reply);
    });
    return;
  }

  const retryBtn = target.closest('button[data-retry-message-id]') as HTMLButtonElement | null;
  if (!retryBtn) {
    return;
  }

  const retryMessageId = retryBtn.dataset.retryMessageId;
  if (!retryMessageId) {
    return;
  }

  event.preventDefault();
  void import('../app').then(({ retryUserMessageById }) => {
    void retryUserMessageById(retryMessageId);
  });
}

export function onToolCallsClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const artifactBtn = target.closest('button[data-artifact-preview-path]') as HTMLButtonElement | null;
  if (!artifactBtn?.dataset.artifactPreviewPath) {
    return;
  }

  const path = decodeArtifactPath(artifactBtn.dataset.artifactPreviewPath);
  if (!path) {
    return;
  }

  event.preventDefault();
  void openArtifactPreview(path);
}

// ── Tool calls display ────────────────────────────────────────────────────────

// 显示工具调用
export function showToolCalls(toolCalls: ToolCall[]) {
  if (toolCalls.length === 0) {
    toolCallsPanelEl.classList.add('hidden');
    toolCallsListEl.innerHTML = '';
    return;
  }

  toolCallsListEl.innerHTML = [...toolCalls]
    .reverse()
    .map(
      (tc) => `
    <div class="tool-call-item">
      <div class="tool-name">${escapeHtml(tc.name)}</div>
      <div class="tool-status">状态: ${tc.status}</div>
      ${
        tc.arguments
          ? `<div class="tool-args">${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</div>`
          : ''
      }
      ${tc.output ? `<div class="tool-output">${formatMessageContent(tc.output)}</div>` : ''}
      ${tc.output ? renderArtifactPreviewActions(tc.output) : ''}
    </div>
  `
    )
    .join('');

  toolCallsPanelEl.classList.remove('hidden');
}

// ── Message rendering ─────────────────────────────────────────────────────────

// 渲染消息
export function renderMessages() {
  persistCurrentSessionMessages();
  let latestInteractiveMessageIndex = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'assistant' || state.messages[i].role === 'user') {
      latestInteractiveMessageIndex = i;
      break;
    }
  }
  const quickActionEnabled = canUseConversationQuickAction();
  const thinkingIndicator = isCurrentAgentBusy()
    ? `<div class="thinking-indicator" aria-live="polite" aria-label="iFlow 正在思考">🤔</div>`
    : '';

  if (state.messages.length === 0) {
    const title = state.currentSessionId ? '当前会话暂无消息' : '👋 欢迎使用 flow hub';
    const hint = state.currentSessionId
      ? '开始输入消息，内容将保存在当前会话中。'
      : '从左侧选择一个 Agent 开始对话，或添加新的 Agent。';
    chatMessagesEl.innerHTML = `
      <div class="welcome-message">
        <h3>${title}</h3>
        <p>${hint}</p>
      </div>
      ${thinkingIndicator}
    `;
    return;
  }

  chatMessagesEl.innerHTML =
    state.messages
      .map((msg, index) => {
      if (msg.role === 'thought') {
        return `
        <div class="message thought">
          <div class="message-avatar">💭</div>
          <div class="message-content thought-content">
            <details class="thought-details">
              <summary>模型思考（默认折叠）</summary>
              <div class="thought-text">${formatMessageContent(msg.content)}</div>
            </details>
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      `;
      }

      const avatar = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
      let quickReplySection = '';
      const isLatestInteractive = index === latestInteractiveMessageIndex;

      if (isLatestInteractive && msg.role === 'assistant') {
        let retryTargetMessageId = '';
        for (let i = index - 1; i >= 0; i -= 1) {
          if (state.messages[i].role === 'user') {
            retryTargetMessageId = state.messages[i].id;
            break;
          }
        }

        quickReplySection = `
          <div class="assistant-quick-replies">
            ${ASSISTANT_QUICK_REPLIES.map(
              (item) => `
              <button
                type="button"
                class="assistant-quick-reply-btn"
                data-quick-reply="${escapeHtml(item)}"
                ${quickActionEnabled ? '' : 'disabled'}
              >
                ${escapeHtml(item)}
              </button>
            `
            ).join('')}
            ${
              retryTargetMessageId
                ? `
                <button
                  type="button"
                  class="assistant-quick-reply-btn secondary"
                  data-retry-message-id="${escapeHtml(retryTargetMessageId)}"
                  ${quickActionEnabled ? '' : 'disabled'}
                >
                  重试上一问
                </button>
              `
                : ''
            }
          </div>
        `;
      }

      if (isLatestInteractive && msg.role === 'user') {
        quickReplySection = `
          <div class="assistant-quick-replies">
            <button
              type="button"
              class="assistant-quick-reply-btn secondary"
              data-retry-message-id="${escapeHtml(msg.id)}"
              ${quickActionEnabled ? '' : 'disabled'}
            >
              重试发送
            </button>
          </div>
        `;
      }

      return `
      <div class="message ${msg.role}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">
          ${formatMessageContent(msg.content)}
          ${renderArtifactPreviewActions(msg.content)}
          <div class="message-time">${formatTime(msg.timestamp)}</div>
          ${quickReplySection}
        </div>
      </div>
    `;
      })
      .join('') + thinkingIndicator;
}

// 滚动到底部
export function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}
