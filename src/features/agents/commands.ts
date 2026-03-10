// src/features/agents/commands.ts — Local command handlers
import type { Message } from '../../types';
import { getMessagesForSession, commitSessionMessages } from '../sessions';
import {
  AUTO_RECONNECT_MODE_DEFAULT,
  getAutoReconnectMode,
  setAutoReconnectMode,
  parseAgentAutoReconnectCommand,
} from './reconnect';

// ── Agent Auto Reconnect Command ──────────────────────────────────────────────

export async function handleLocalAgentCommand(
  content: string,
  sessionId: string,
): Promise<boolean> {
  const command = parseAgentAutoReconnectCommand(content);
  if (!command) {
    return false;
  }

  const sessionMessages = getMessagesForSession(sessionId);
  const userMessage: Message = {
    id: `msg-${Date.now()}-agent-user`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  sessionMessages.push(userMessage);
  commitSessionMessages(sessionId, sessionMessages);

  if (command.kind === 'invalid') {
    const invalidMessage: Message = {
      id: `msg-${Date.now()}-agent-autoreconnect-invalid`,
      role: 'system',
      content: '⚠ 参数无效。用法：/agents autoreconnect [last|all|off]',
      timestamp: new Date(),
    };
    sessionMessages.push(invalidMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  if (command.kind === 'show') {
    const mode = getAutoReconnectMode();
    const showMessage: Message = {
      id: `msg-${Date.now()}-agent-autoreconnect-show`,
      role: 'system',
      content:
        `⚙️ 当前自动重连模式：${mode}\n` +
        '可选值：last（仅最后一个） / all（全部） / off（关闭）\n' +
        '设置示例：/agents autoreconnect last',
      timestamp: new Date(),
    };
    sessionMessages.push(showMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  setAutoReconnectMode(command.mode || AUTO_RECONNECT_MODE_DEFAULT);
  const setMessage: Message = {
    id: `msg-${Date.now()}-agent-autoreconnect-set`,
    role: 'system',
    content: `✅ 自动重连模式已设置为：${command.mode}`,
    timestamp: new Date(),
  };
  sessionMessages.push(setMessage);
  commitSessionMessages(sessionId, sessionMessages);
  return true;
}
