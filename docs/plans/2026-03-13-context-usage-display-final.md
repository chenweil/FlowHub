# 上下文使用显示功能设计文档 (Final)

**版本：** v2.0
**日期：** 2026-03-13
**状态：** 部分实现（压缩按钮 ✅，进度条 ⬜）

---

## 1. 需求概述

### 1.1 功能目标

在输入区域展示当前会话的上下文使用情况，包括：
- 图形化进度条显示已使用百分比
- 根据使用率动态变色（绿色/黄色/红色）
- 显示估算的 token 使用量
- 支持一键压缩上下文

### 1.2 用户场景

1. **正常对话**：用户发送消息时，实时看到上下文占用情况
2. **高占用提醒**：当上下文接近上限时，通过颜色变化提醒用户
3. **手动压缩**：用户点击按钮主动触发上下文压缩

---

## 2. 背景

### 2.1 当前实现状态

| 项目 | 状态 | 说明 |
|------|------|------|
| iFlow API 返回 `usage` | ❌ 不支持 | CLI 会话文件中值为 0，ACP 协议未暴露 |
| ACP 协议暴露上下文信息 | ❌ 未找到 | 搜索 `contextUsage`、`maxContextTokens` 等关键词未找到相关字段 |
| `/compress` 命令 | ✅ 支持 | iFlow CLI 支持 `/compress` 命令 |
| 模型信息 | ✅ 支持 | ACP 协议返回当前模型名称（`model-registry` 事件），可推断上下文窗口 |

### 2.2 关键结论

1. **iFlow CLI 未提供上下文使用 API** — 需要通过前端估算
2. **模型名称可获取** — 通过 `model-registry` 事件获取当前模型
3. **压缩命令可用** — 直接发送 `/compress` 即可

### 2.3 范围与非目标

**范围：**
- ✅ 实现基于前端估算的上下文使用量显示
- ✅ 实现点击进度条触发压缩功能
- ✅ 根据模型名称动态调整上下文窗口大小

**非目标：**
- 不等待 iFlow CLI 提供官方 API
- 不改变现有消息发送/接收机制
- 不引入新的依赖库
- 不实现自动压缩（保留手动触发）

---

## 3. 技术方案

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (TypeScript)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐      ┌──────────────────────┐        │
│  │  Compress Button │      │ Context Usage Bar    │        │
│  │  (已实现)        │      │ (待实现)             │        │
│  └────────┬─────────┘      └──────────┬───────────┘        │
│           │                           │                     │
│           └───────────┬───────────────┘                     │
│                       │                                     │
│           ┌───────────┴───────────┐                        │
│           │    Token Utils        │                        │
│           │  (estimateTokens)     │                        │
│           └───────────┬───────────┘                        │
│                       │                                     │
│           ┌───────────┴───────────┐                        │
│           │   Model Context       │                        │
│           │  (getContextWindow)   │                        │
│           └───────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| Token 估算 | `src/lib/tokens.ts` | 基于文本内容估算 token 数量 |
| 模型上下文 | `src/lib/modelContext.ts` | 根据模型名称推断上下文窗口大小 |
| 压缩功能 | `src/features/app.ts` | 发送 `/compress` 命令（已实现） |
| 使用量显示 | `src/features/contextUsage.ts` | 计算并更新进度条显示 |

---

## 4. 详细设计

### 4.1 Token 估算算法

由于 iFlow CLI 未提供实际 token 使用接口，采用前端估算：

```typescript
// src/lib/tokens.ts

import type { Message } from '../types';

/**
 * 估算文本的 token 数量
 * 算法：
 * - 英文/数字/符号：约 4 字符 = 1 token
 * - 中文/日文/韩文：约 1 字符 = 1 token
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length;
  const nonAsciiChars = text.length - asciiChars;

  return Math.ceil(asciiChars / 4) + nonAsciiChars;
}

export interface ContextUsage {
  usedTokens: number;
  totalTokens: number;
  percentage: number;
  remainingTokens: number;
}

export function calculateContextUsage(
  messages: Message[],
  contextWindow: number
): ContextUsage {
  const usedTokens = messages.reduce(
    (sum, msg) => sum + estimateTokens(msg.content),
    0
  );

  const percentage = Math.min((usedTokens / contextWindow) * 100, 100);

  return {
    usedTokens,
    totalTokens: contextWindow,
    percentage: Math.round(percentage),
    remainingTokens: Math.max(0, contextWindow - usedTokens)
  };
}
```

### 4.2 模型上下文推断

```typescript
// src/lib/modelContext.ts

import { state } from '../store';

const MODEL_CONTEXT_MAP: Record<string, number> = {
  // OpenAI
  'gpt-4': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-3.5-turbo': 16384,

  // Kimi
  'kimi': 128000,
  'kimi-k2': 128000,
  'kimi-k2.5': 128000,
  'kimi-k2-nostream': 128000,

  // Claude
  'claude': 200000,
  'claude-3': 200000,
  'claude-3.5': 200000,
  'claude3.5': 200000,
  'claude3.5-nostream': 200000,

  // Qwen
  'qwen': 128000,
  'qwen2': 128000,
  'qwen2.5': 128000,
  'qwen3': 128000,
  'qwen3-coder': 128000,

  // GLM
  'glm': 128000,
  'glm-4': 128000,
  'glm-4.5': 128000,
  'glm4.5': 128000,
  'glm-5': 128000,

  // MiniMax
  'minimax': 128000,
  'minimax-m2.5': 128000,

  // 默认
  'default': 128000,
};

/**
 * 根据模型名称获取上下文窗口大小
 */
export function getContextWindow(modelName: string): number {
  if (!modelName) return MODEL_CONTEXT_MAP['default'];

  const normalized = modelName.toLowerCase();

  // 精确匹配
  if (MODEL_CONTEXT_MAP[normalized]) {
    return MODEL_CONTEXT_MAP[normalized];
  }

  // 模糊匹配（包含关系）
  for (const [key, value] of Object.entries(MODEL_CONTEXT_MAP)) {
    if (normalized.includes(key)) return value;
  }

  return MODEL_CONTEXT_MAP['default'];
}

/**
 * 获取当前 Agent 的上下文窗口
 * 通过 state.currentAgentId 查找 agent.selectedModel
 */
export function getCurrentAgentContextWindow(): number {
  const agent = state.currentAgentId
    ? state.agents.find(a => a.id === state.currentAgentId)
    : null;

  if (!agent?.selectedModel) {
    return MODEL_CONTEXT_MAP['default'];
  }

  return getContextWindow(agent.selectedModel);
}
```

### 4.3 UI 设计

#### 4.3.1 压缩按钮（已实现 ✅）

位置：输入框左侧
图标：压缩箭头 SVG
状态：
- 正常：灰色背景
- 悬停：蓝色边框
- 压缩中：蓝色背景 + 脉冲动画
- 禁用：50% 透明度

```css
.btn-compress {
  width: 40px;
  height: 40px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s, border-color 0.2s;
}

.btn-compress.compressing {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: white;
  animation: compress-pulse 1s ease-in-out infinite;
}

@keyframes compress-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
```

#### 4.3.2 上下文进度条（待实现 ⬜）

位置：`.input-container` 内，`.input-wrapper` 与 `.input-hints` 之间

```html
<!-- 位于 .input-wrapper 下方，.input-hints 上方 -->
<div class="context-usage-container" id="context-usage-container">
  <div class="context-usage-bar">
    <div class="context-usage-fill" id="context-usage-fill"></div>
  </div>
  <div class="context-usage-info">
    <span id="context-usage-text">上下文: 0% (估算)</span>
    <span class="context-usage-hint" id="context-usage-hint">点击压缩</span>
  </div>
</div>
```

颜色规则：

| 使用率 | 颜色 | CSS 变量 | 提示文字 |
|--------|------|----------|----------|
| < 50% | 绿色 | `--success-color` | 点击压缩 |
| 50-80% | 黄色 | `--warning-color` | 建议压缩 |
| > 80% | 红色 | `--error-color` | ⚠️ 建议立即压缩 |

```css
/* 上下文使用进度条 */
.context-usage-container {
  margin-top: 8px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.context-usage-container:hover {
  opacity: 0.8;
}

.context-usage-bar {
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}

.context-usage-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease, background-color 0.3s ease;
  background-color: var(--success-color);
}

.context-usage-fill.warning {
  background-color: var(--warning-color);
}

.context-usage-fill.danger {
  background-color: var(--error-color);
}

.context-usage-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.context-usage-hint {
  font-size: 11px;
  color: var(--text-muted);
}
```

### 4.4 压缩功能（已实现 ✅）

压缩按钮的事件处理已在 `src/features/app.ts` 中实现，进度条点击复用同一函数：

```typescript
// src/features/app.ts（已实现，无需修改）

export async function sendCompressCommand() {
  const sessionId = state.currentSessionId;
  const agentId = state.currentAgentId;

  if (!sessionId || !agentId) {
    showError('请先选择 Agent 和会话');
    return;
  }

  const agent = state.agents.find((a) => a.id === agentId);
  if (agent?.status !== 'connected') {
    showError('当前 Agent 离线，无法执行压缩');
    return;
  }

  if (isCurrentAgentBusy() || state.isCompressing) {
    showError('正在处理中，请稍后再试');
    return;
  }

  state.isCompressing = true;
  compressBtnEl.classList.add('compressing');
  compressBtnEl.title = '正在压缩...';

  try {
    await tauriSendMessage(sessionId, '/compress', agentId);
  } catch (error) {
    console.error('压缩失败:', error);
    showError(`压缩失败: ${String(error)}`);
    clearCompressingState();
  }
}

export function clearCompressingState() {
  if (state.isCompressing) {
    state.isCompressing = false;
    compressBtnEl.classList.remove('compressing');
    compressBtnEl.title = '压缩上下文';
  }
}
```

### 4.5 上下文使用量显示（待实现 ⬜）

```typescript
// src/features/contextUsage.ts

import { state } from '../store';
import { calculateContextUsage } from '../lib/tokens';
import { getCurrentAgentContextWindow } from '../lib/modelContext';
import {
  contextUsageFillEl,
  contextUsageTextEl,
  contextUsageHintEl,
  contextUsageContainerEl,
} from '../dom';

/**
 * 更新上下文使用量显示
 * 在 renderMessages() 和会话切换时调用
 */
export function updateContextUsageDisplay(): void {
  if (!state.currentSessionId) {
    hideContextUsage();
    return;
  }

  const messages = state.messagesBySession[state.currentSessionId] || [];
  const contextWindow = getCurrentAgentContextWindow();
  const usage = calculateContextUsage(messages, contextWindow);

  // 显示容器
  if (contextUsageContainerEl) {
    contextUsageContainerEl.style.display = '';
  }

  // 更新进度条
  if (contextUsageFillEl) {
    contextUsageFillEl.style.width = `${usage.percentage}%`;
    contextUsageFillEl.className = 'context-usage-fill';

    if (usage.percentage > 80) {
      contextUsageFillEl.classList.add('danger');
    } else if (usage.percentage > 50) {
      contextUsageFillEl.classList.add('warning');
    }
  }

  // 更新文字
  if (contextUsageTextEl) {
    const usedK = Math.round(usage.usedTokens / 1000);
    const totalK = Math.round(usage.totalTokens / 1000);
    contextUsageTextEl.textContent = `上下文: ${usage.percentage}% (${usedK}K / ${totalK}K 估算)`;
  }

  // 更新提示
  if (contextUsageHintEl) {
    if (usage.percentage > 80) {
      contextUsageHintEl.textContent = '⚠️ 建议立即压缩';
    } else if (usage.percentage > 50) {
      contextUsageHintEl.textContent = '建议压缩';
    } else {
      contextUsageHintEl.textContent = '点击压缩';
    }
  }
}

function hideContextUsage(): void {
  if (contextUsageContainerEl) {
    contextUsageContainerEl.style.display = 'none';
  }
}
```

---

## 5. 集成点

### 5.1 DOM 引用（`src/dom.ts`）

```typescript
// 新增导出
export const contextUsageContainerEl = document.getElementById('context-usage-container') as HTMLDivElement;
export const contextUsageFillEl = document.getElementById('context-usage-fill') as HTMLDivElement;
export const contextUsageTextEl = document.getElementById('context-usage-text') as HTMLSpanElement;
export const contextUsageHintEl = document.getElementById('context-usage-hint') as HTMLSpanElement;
```

### 5.2 消息渲染时更新

```typescript
// src/features/ui/index.ts - renderMessages()

import { updateContextUsageDisplay } from '../contextUsage';

export function renderMessages(): void {
  // ... 现有渲染逻辑

  // 更新上下文使用量显示
  updateContextUsageDisplay();
}
```

### 5.3 会话切换时更新

```typescript
// src/features/sessions/index.ts

import { updateContextUsageDisplay } from '../contextUsage';

// 在 switchSession 相关逻辑末尾调用
updateContextUsageDisplay();
```

### 5.4 进度条点击事件（`src/features/app.ts`）

```typescript
// setupEventListeners() 中新增

import { contextUsageContainerEl } from '../dom';

// 进度条点击触发压缩（复用已有的 sendCompressCommand）
if (contextUsageContainerEl) {
  contextUsageContainerEl.addEventListener('click', () => {
    void sendCompressCommand();
  });
}
```

### 5.5 状态管理（`src/store.ts`）

已有 `isCompressing` 字段，无需新增状态。

---

## 6. 文件改动清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/lib/tokens.ts` | Token 估算工具函数 + `ContextUsage` 类型 |
| `src/lib/modelContext.ts` | 模型上下文窗口推断 + `getCurrentAgentContextWindow()` |
| `src/features/contextUsage.ts` | `updateContextUsageDisplay()` 进度条更新逻辑 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.html` | `.input-wrapper` 与 `.input-hints` 之间插入进度条 HTML |
| `src/styles.css` | 添加 `.context-usage-*` 样式 |
| `src/dom.ts` | 添加 4 个 DOM 引用导出 |
| `src/features/app.ts` | `setupEventListeners()` 中添加进度条点击监听 |
| `src/features/ui/index.ts` | `renderMessages()` 末尾调用 `updateContextUsageDisplay()` |
| `src/features/sessions/index.ts` | 会话切换时调用 `updateContextUsageDisplay()` |

---

## 7. 显示示例

```
┌──────────────────────────────────────────────────┐
│ [消息区域]                                         │
│                                                   │
├──────────────────────────────────────────────────┤
│ ┌──────────────────────────────────┐ [压缩] [发送]│
│ │ 输入框                           │             │
│ └──────────────────────────────────┘             │
│ ━━━━━━━━━━━━━━━━━━━━━━━╸                         │
│ 上下文: 45% (58K/128K 估算)        点击压缩      │
│ 按 Enter 发送，Shift + Enter 换行                │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸ (黄色)        │
│ 上下文: 75% (96K/128K 估算)        建议压缩      │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸ (红色)     │
│ 上下文: 92% (118K/128K 估算)   ⚠️ 建议立即压缩   │
└──────────────────────────────────────────────────┘
```

---

## 8. 测试策略

### 8.1 单元测试

```typescript
// tokens.test.ts

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should estimate ASCII text', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 3
  });

  it('should estimate Chinese text', () => {
    expect(estimateTokens('你好世界')).toBe(4); // 4 chars = 4
  });

  it('should estimate mixed text', () => {
    expect(estimateTokens('hello 世界')).toBe(4); // ceil(6/4) + 2 = 2 + 2 = 4
  });
});
```

### 8.2 集成测试

1. 发送消息时进度条是否更新
2. 切换会话时进度条是否正确显示
3. 压缩按钮和进度条点击是否正常触发
4. 不同模型是否显示正确的上下文窗口
5. 空会话、单条消息、大量消息的边界情况

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Token 估算不准确 | 中 | 显示"估算"标签，告知用户这是近似值 |
| 模型不在映射表中 | 低 | 使用默认值 128K |
| 压缩命令失败 | 中 | 错误提示，恢复按钮状态（已实现） |
| 大量消息时计算慢 | 低 | `estimateTokens` 为纯计算，性能可接受 |

---

## 10. 实施计划

### Phase 1: 压缩按钮（已完成 ✅）

- [x] HTML 结构（`index.html`）
- [x] CSS 样式（`src/styles.css`）
- [x] DOM 引用（`src/dom.ts` — `compressBtnEl`）
- [x] 压缩功能（`src/features/app.ts` — `sendCompressCommand` / `clearCompressingState`）
- [x] 状态管理（`src/store.ts` — `isCompressing`）

### Phase 2: 上下文进度条（待实施 ⬜）

1. ⬜ 创建 `src/lib/tokens.ts` — Token 估算 + `ContextUsage` 类型
2. ⬜ 创建 `src/lib/modelContext.ts` — 模型上下文推断 + `getCurrentAgentContextWindow()`
3. ⬜ 创建 `src/features/contextUsage.ts` — `updateContextUsageDisplay()`
4. ⬜ 修改 `index.html` — 在 `.input-wrapper` 与 `.input-hints` 之间插入进度条 HTML
5. ⬜ 修改 `src/styles.css` — 添加 `.context-usage-*` 样式
6. ⬜ 修改 `src/dom.ts` — 添加 4 个 DOM 引用
7. ⬜ 修改 `src/features/app.ts` — `setupEventListeners()` 添加进度条点击监听
8. ⬜ 修改 `src/features/ui/index.ts` — `renderMessages()` 末尾调用 `updateContextUsageDisplay()`
9. ⬜ 修改 `src/features/sessions/index.ts` — 会话切换时调用 `updateContextUsageDisplay()`
10. ⬜ 测试验证

---

## 11. 参考资料

- `src-tauri/src/router.rs` — 消息路由处理
- `src-tauri/src/agents/iflow_adapter.rs` — WebSocket 消息监听
- `src/services/events.ts` — 前端事件定义
- `src/features/ui/index.ts` — UI 渲染（`renderMessages()`）
- `src/types.ts` — `Agent.selectedModel` 类型定义

---

**文档历史**

| 版本 | 日期 | 修改内容 |
|------|------|----------|
| v1.0 | 2026-03-13 | 初始版本（design.md） |
| v2.0 | 2026-03-13 | Final 合并版：以 design.md 为主体，合并 display.md 的完整模型映射表、背景调研、`getCurrentAgentContextWindow()` 辅助函数；修正 `updateContextUsageDisplay` 使用 DOM 引用而非 `getElementById`；进度条点击复用已有 `sendCompressCommand`；修正单元测试中混合文本的期望值 |
