import type { Message } from '../types';

const HISTORY_CONTINUATION_MAX_MESSAGES = 16;
const HISTORY_CONTINUATION_MAX_CHARS = 12000;

function roleLabel(role: Message['role']): string {
  if (role === 'user') {
    return '用户';
  }
  if (role === 'assistant') {
    return '助手';
  }
  return '系统';
}

export function buildHistoryContinuationPrompt(historyMessages: Message[], currentInput: string): string {
  const transcript = historyMessages
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .slice(-HISTORY_CONTINUATION_MAX_MESSAGES)
    .map((item) => `${roleLabel(item.role)}: ${item.content.trim()}`)
    .filter((line) => line.length > 0)
    .join('\n\n');

  if (!transcript) {
    return currentInput;
  }

  const normalizedTranscript =
    transcript.length > HISTORY_CONTINUATION_MAX_CHARS
      ? `...${transcript.slice(-HISTORY_CONTINUATION_MAX_CHARS)}`
      : transcript;

  return [
    '你正在继续一个历史会话。',
    '以下是最近对话片段，请基于这些上下文回答，不要重新自我介绍。',
    '',
    '[历史对话开始]',
    normalizedTranscript,
    '[历史对话结束]',
    '',
    `用户最新问题: ${currentInput}`,
  ].join('\n');
}
