# Context Usage Display Design

**日期：** 2026-03-13  
**更新日期：** 2026-03-13（第二版）

## 目标

- 在输入框下方显示模型上下文使用量和剩余百分比。
- 提供图形化展示（进度条）直观显示占用和剩余。
- 支持点击触发上下文压缩功能。

## 背景

### 当前实现状态

| 项目 | 状态 | 说明 |
|------|------|------|
| iFlow API 返回 `usage` | ❌ 不支持 | CLI 会话文件中值为 0，ACP 协议未暴露 |
| ACP 协议暴露上下文信息 | ❌ 未找到 | 搜索 `contextUsage`、`maxContextTokens` 等关键词未找到相关字段 |
| `/compress` 命令 | ✅ 支持 | iFlow CLI 支持 `/compress` 命令 |
| 模型信息 | ✅ 支持 | ACP 协议返回当前模型名称，可推断上下文窗口 |

### 关键结论

1. **iFlow CLI 未提供上下文使用 API** - 需要通过前端估算
2. **模型名称可获取** - 通过 `model-registry` 事件获取当前模型
3. **压缩命令可用** - 直接发送 `/compress` 即可

## 范围

- ✅ 实现基于前端估算的上下文使用量显示
- ✅ 实现点击进度条触发压缩功能
- ✅ 根据模型名称动态调整上下文窗口大小

## 非目标

- 不等待 iFlow CLI 提供官方 API
- 不改变现有消息发送/接收机制
- 不引入新的依赖库
- 不实现自动压缩（保留手动触发）

## 技术方案

### 1. Token 估算算法

由于 iFlow CLI 未提供实际 token 使用接口，采用前端估算方案：

```typescript
// src/lib/tokens.ts

/**
 * 估算文本的 token 数量
 * 算法说明：
 * - 英文/数字/符号：约 4 字符 = 1 token
 * - 中文/日文/韩文：约 1 字符 = 1 token
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  
  // 统计英文/ASCII 字符数
  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length;
  
  // 统计非 ASCII 字符数（主要是中文）
  const nonAsciiChars = text.length - asciiChars;
  
  // 计算估算值
  const asciiTokens = Math.ceil(asciiChars / 4);
  const nonAsciiTokens = nonAsciiChars;
  
  return asciiTokens + nonAsciiTokens;
}

/**
 * 计算当前会话上下文使用情况
 */
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
  
  const percentage = Math.min(
    (usedTokens / contextWindow) * 100, 
    100
  );
  
  return {
    usedTokens,
    totalTokens: contextWindow,
    percentage: Math.round(percentage),
    remainingTokens: Math.max(0, contextWindow - usedTokens)
  };
}
```

### 2. 基于模型名称的上下文窗口推断

```typescript
// src/lib/modelContext.ts

export interface ModelContextInfo {
  contextWindow: number;
  displayName: string;
}

// 常见模型的上下文窗口映射表
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
    if (normalized.includes(key)) {
      return value;
    }
  }
  
  return MODEL_CONTEXT_MAP['default'];
}

/**
 * 获取当前 Agent 的上下文窗口
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

### 3. UI 组件设计

#### 进度条组件

```html
<!-- 位于 .input-container 内，在 .input-wrapper 下方 -->
<div class="context-usage-container" id="context-usage-container">
  <div class="context-usage-bar" id="context-usage-bar" title="点击压缩上下文">
    <div class="context-usage-fill" id="context-usage-fill"></div>
  </div>
  <div class="context-usage-info">
    <span id="context-usage-text">上下文: 0% (估算)</span>
    <span class="context-usage-hint" id="context-usage-hint"></span>
  </div>
</div>
```

#### 颜色方案

| 使用率 | 颜色 | CSS 变量 | 提示文字 |
|--------|------|----------|----------|
| < 50% | 绿色 | `--success-color` | 点击压缩 |
| 50-80% | 黄色 | `--warning-color` | 上下文较多，建议压缩 |
| > 80% | 红色 | `--error-color` | ⚠️ 上下文即将用尽 |

#### CSS 样式

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

### 4. 压缩功能实现

```typescript
// src/features/contextUsage.ts

import { sendMessage } from '../services/tauri';
import { showConfirmDialog } from '../dom';
import { state } from '../store';

/**
 * 处理压缩上下文操作
 */
export async function handleCompressContext(): Promise<void> {
  if (!state.currentAgentId || !state.currentSessionId) {
    showError('请先选择 Agent 和会话');
    return;
  }

  const agent = state.agents.find(a => a.id === state.currentAgentId);
  if (agent?.status !== 'connected') {
    showError('当前 Agent 离线，无法执行压缩');
    return;
  }

  const confirmed = await showConfirmDialog(
    '压缩上下文',
    '确定要压缩当前会话的上下文吗？这将总结历史消息以减少 token 使用。'
  );

  if (!confirmed) return;

  try {
    await sendMessage(
      state.currentAgentId,
      '/compress',
      state.currentSessionId
    );
  } catch (error) {
    console.error('压缩失败:', error);
    showError(`压缩失败: ${error}`);
  }
}

/**
 * 更新上下文使用量显示
 */
export function updateContextUsageDisplay(): void {
  if (!state.currentSessionId) {
    hideContextUsage();
    return;
  }

  const messages = state.messagesBySession[state.currentSessionId] || [];
  const contextWindow = getCurrentAgentContextWindow();
  const usage = calculateContextUsage(messages, contextWindow);

  // 更新进度条
  const fillEl = document.getElementById('context-usage-fill');
  const textEl = document.getElementById('context-usage-text');
  const hintEl = document.getElementById('context-usage-hint');

  if (fillEl) {
    fillEl.style.width = `${usage.percentage}%`;
    fillEl.className = 'context-usage-fill';
    
    if (usage.percentage > 80) {
      fillEl.classList.add('danger');
    } else if (usage.percentage > 50) {
      fillEl.classList.add('warning');
    }
  }

  if (textEl) {
    const usedK = Math.round(usage.usedTokens / 1000);
    const totalK = Math.round(usage.totalTokens / 1000);
    textEl.textContent = `上下文: ${usage.percentage}% (${usedK}K / ${totalK}K 估算)`;
  }

  if (hintEl) {
    if (usage.percentage > 80) {
      hintEl.textContent = '⚠️ 建议立即压缩';
    } else if (usage.percentage > 50) {
      hintEl.textContent = '建议压缩';
    } else {
      hintEl.textContent = '点击压缩';
    }
  }
}
```

### 5. 集成点

#### 消息渲染时更新

```typescript
// src/features/ui/index.ts - renderMessages()

export function renderMessages(): void {
  // ... 现有渲染逻辑
  
  // 更新上下文使用量显示
  updateContextUsageDisplay();
}
```

#### 会话切换时更新

```typescript
// src/features/sessions/index.ts - switchSession()

export function switchSession(sessionId: string): void {
  // ... 现有切换逻辑
  
  // 更新上下文使用量显示
  updateContextUsageDisplay();
}
```

#### 事件监听

```typescript
// src/features/app.ts - setupEventListeners()

export function setupEventListeners(): void {
  // ... 现有事件监听
  
  // 上下文使用量进度条点击
  const contextUsageBar = document.getElementById('context-usage-container');
  if (contextUsageBar) {
    contextUsageBar.addEventListener('click', handleCompressContext);
  }
}
```

## 文件改动清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/lib/tokens.ts` | Token 估算工具函数 |
| `src/lib/modelContext.ts` | 模型上下文窗口推断 |
| `src/features/contextUsage.ts` | 上下文使用量管理 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.html` | 添加进度条 HTML 结构 |
| `src/styles.css` | 添加进度条样式 |
| `src/dom.ts` | 添加 DOM 引用导出 |
| `src/store.ts` | 添加上下文使用状态（可选） |
| `src/features/app.ts` | 添加事件监听和初始化 |
| `src/features/ui/index.ts` | 在 renderMessages 中调用更新 |
| `src/features/sessions/index.ts` | 在会话切换时更新 |

## 显示格式示例

```
上下文: 45% (58K / 128K 估算)          点击压缩
━━━━━━━━━━━━━━━━━━━━━━━╸

上下文: 75% (96K / 128K 估算)          建议压缩
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸

上下文: 92% (118K / 128K 估算)         ⚠️ 建议立即压缩
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸
```

## 测试要点

1. **估算准确性**：对比估算值与实际 iFlow CLI 显示的 token 数（如有）
2. **模型识别**：测试不同模型是否正确显示对应的上下文窗口
3. **UI 响应性**：快速发送多条消息，观察进度条是否平滑更新
4. **压缩功能**：验证点击后的确认对话框和消息发送
5. **边界值测试**：测试空会话、单条消息、大量消息的显示情况

## 实施顺序

### 阶段 1：压缩按钮（已完成 ✅）

1. ✅ 修改 `index.html` - 添加压缩按钮 HTML
2. ✅ 修改 `src/dom.ts` - 添加 `compressBtnEl` DOM 引用
3. ✅ 修改 `src/features/app.ts` - 添加 `sendCompressCommand()` 函数和事件监听
4. ✅ 修改 `src/styles.css` - 添加 `.btn-compress` 样式
5. ⬜ 测试验证

### 阶段 2：上下文使用量显示（待实现）

1. ⬜ 创建 `src/lib/tokens.ts` - Token 估算
2. ⬜ 创建 `src/lib/modelContext.ts` - 模型上下文推断
3. ⬜ 创建 `src/features/contextUsage.ts` - 核心功能
4. ⬜ 修改 `index.html` - 添加 HTML 结构
5. ⬜ 修改 `src/styles.css` - 添加样式
6. ⬜ 修改 `src/dom.ts` - 添加 DOM 引用
7. ⬜ 修改 `src/features/app.ts` - 添加事件监听
8. ⬜ 修改 `src/features/ui/index.ts` - 集成渲染
9. ⬜ 测试验证

## 参考资料

- `src-tauri/src/router.rs` - 消息路由处理
- `src-tauri/src/agents/iflow_adapter.rs` - WebSocket 消息监听
- `src/services/events.ts` - 前端事件定义
- `src/features/ui/index.ts` - UI 渲染
- `src/types.ts` - ModelOption 类型定义
