# 上下文使用显示功能设计文档（codex final）

**版本：** v1.0（合并版）  
**日期：** 2026-03-13  
**状态：** 已实现（压缩按钮 ✅，进度条 ✅）

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

### 1.3 范围

- ✅ 实现基于前端估算的上下文使用量显示
- ✅ 实现点击进度条触发压缩功能
- ✅ 根据模型名称动态调整上下文窗口大小

### 1.4 非目标

- 不等待 iFlow CLI 提供官方 API
- 不改变现有消息发送/接收机制
- 不引入新的依赖库
- 不实现自动压缩（保留手动触发）

---

## 2. 背景

### 2.1 当前实现状态

| 项目 | 状态 | 说明 |
|------|------|------|
| iFlow API 返回 `usage` | ❌ 不支持 | CLI 会话文件中值为 0，ACP 协议未暴露 |
| ACP 协议暴露上下文信息 | ❌ 未找到 | 搜索 `contextUsage`、`maxContextTokens` 等关键词未找到相关字段 |
| `/compress` 命令 | ✅ 支持 | iFlow CLI 支持 `/compress` 命令 |
| 模型信息 | ✅ 支持 | ACP 协议返回当前模型名称，可推断上下文窗口 |

### 2.2 关键结论

1. **iFlow CLI 未提供上下文使用 API** - 需要通过前端估算
2. **模型名称可获取** - 通过 `model-registry` 事件获取当前模型
3. **压缩命令可用** - 直接发送 `/compress` 即可

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
│              ┌────────┴────────┐                           │
│              │   Token Utils   │                           │
│              │  (estimateTokens)│                           │
│              └─────────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| Token 估算 | `src/lib/tokens.ts` | 基于文本内容估算 token 数量 |
| 模型上下文 | `src/lib/modelContext.ts` | 根据模型名称推断上下文窗口大小 |
| 压缩功能 | `src/features/app.ts` | 发送 `/compress` 命令 |
| 使用量显示 | `src/features/contextUsage.ts` | 计算并更新进度条显示 |

---

## 4. 详细设计

### 4.1 Token 估算算法

由于 iFlow CLI 未提供实际 token 使用接口，采用前端估算：

```typescript
// src/lib/tokens.ts

/**
 * 估算文本的 token 数量
 * 算法：英文4字符≈1token，中文1字符≈1token
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

> 说明：以下为建议映射，需依据 `model-registry` 返回值逐步补充或裁剪。默认 128K。

```typescript
// src/lib/modelContext.ts

const MODEL_CONTEXT_MAP: Record<string, number> = {
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

  // GPT
  'gpt-4': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-3.5-turbo': 16384,

  // MiniMax
  'minimax': 128000,
  'minimax-m2.5': 128000,

  // 默认
  'default': 128000,
};

export function getContextWindow(modelName: string): number {
  if (!modelName) return MODEL_CONTEXT_MAP['default'];
  
  const normalized = modelName.toLowerCase();
  
  if (MODEL_CONTEXT_MAP[normalized]) {
    return MODEL_CONTEXT_MAP[normalized];
  }
  
  for (const [key, value] of Object.entries(MODEL_CONTEXT_MAP)) {
    if (normalized.includes(key)) return value;
  }
  
  return MODEL_CONTEXT_MAP['default'];
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

位置：输入框下方  
样式：水平进度条 + 文字信息

```html
<div class="context-usage-container" id="context-usage-container">
  <div class="context-usage-bar" id="context-usage-bar" title="点击压缩上下文">
    <div class="context-usage-fill" id="context-usage-fill"></div>
  </div>
  <div class="context-usage-info">
    <span id="context-usage-text">上下文: 0% (估算)</span>
    <span class="context-usage-hint" id="context-usage-hint">点击压缩</span>
  </div>
</div>
```

颜色规则：

| 使用率 | 颜色 | 状态 |
|--------|------|------|
| < 50% | 绿色 (`--success-color`) | 正常 |
| 50-80% | 黄色 (`--warning-color`) | 警告 |
| > 80% | 红色 (`--error-color`) | 危险 |

### 4.4 压缩功能实现（已实现 ✅）

```typescript
// src/features/app.ts

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
```

> 备注：若需要确认弹窗，可在点击进度条时增加可选确认逻辑。

---

## 5. 集成点

### 5.1 消息渲染时更新进度条

```typescript
// src/features/ui/index.ts

export function renderMessages(): void {
  // ... 现有渲染逻辑
  updateContextUsageDisplay();
}
```

### 5.2 会话切换时更新

```typescript
// src/features/sessions/index.ts

export function switchSession(sessionId: string): void {
  // ... 现有切换逻辑
  updateContextUsageDisplay();
}
```

### 5.3 点击进度条触发压缩

```typescript
// src/features/app.ts - setupEventListeners()

export function setupEventListeners(): void {
  // ... 现有事件监听
  const contextUsageBar = document.getElementById('context-usage-container');
  if (contextUsageBar) {
    contextUsageBar.addEventListener('click', sendCompressCommand);
  }
}
```

---

## 6. 实施计划

### Phase 1: 压缩按钮（已完成 ✅）

- [x] HTML 结构（`index.html`）
- [x] CSS 样式（`src/styles.css`）
- [x] DOM 引用（`src/dom.ts`）
- [x] 压缩功能（`src/features/app.ts`）
- [x] 状态管理（`src/store.ts`）

### Phase 2: 上下文进度条（已完成 ✅）

- [x] 创建 `src/lib/tokens.ts` - Token 估算工具
- [x] 创建 `src/lib/modelContext.ts` - 模型上下文推断
- [x] 创建 `src/features/contextUsage.ts` - 核心功能
- [x] 修改 `index.html` - 添加进度条 HTML
- [x] 修改 `src/styles.css` - 添加进度条样式
- [x] 修改 `src/features/ui/index.ts` - 集成渲染
- [x] 修改 `src/features/app.ts` - refreshComposerState + 进度条点击事件

---

## 7. 测试策略

### 7.1 单元测试

```typescript
// tokens.test.ts

describe('estimateTokens', () => {
  it('should estimate ASCII text', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });
  
  it('should estimate Chinese text', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  
  it('should estimate mixed text', () => {
    expect(estimateTokens('hello 世界')).toBe(6);
  });
});
```

### 7.2 集成测试

1. 发送消息时进度条是否更新
2. 切换会话时进度条是否正确显示
3. 压缩按钮是否正常触发
4. 不同模型是否显示正确的上下文窗口
5. 边界值测试：空会话、单条消息、大量消息

---

## 8. 显示示例

```
┌──────────────────────────────────────────────────┐
│ [消息区域]                                         │
│                                                   │
├──────────────────────────────────────────────────┤
│ ┌──────────────────────────────────┐ [压缩] [发送]│
│ │ 输入框                           │             │
│ └──────────────────────────────────┘             │
│ ━━━━━━━━━━━━━━━━━━━━━━━╸ 45% (58K/128K 估算)     │
│                          点击压缩                │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ [消息区域]                                         │
│                                                   │
├──────────────────────────────────────────────────┤
│ ┌──────────────────────────────────┐ [压缩] [发送]│
│ │ 输入框                           │             │
│ └──────────────────────────────────┘             │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸ 92% (118K/128K)│
│                          ⚠️ 建议立即压缩          │
└──────────────────────────────────────────────────┘
```

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Token 估算不准确 | 中 | 显示“估算”标签，告知用户这是近似值 |
| 模型不在映射表中 | 低 | 使用默认值 128K |
| 压缩命令失败 | 中 | 错误提示，恢复按钮状态 |
| 大量消息时计算慢 | 低 | 优化算法，使用缓存 |

---

## 10. 参考文档

- `src-tauri/src/router.rs` - 消息路由处理
- `src-tauri/src/agents/iflow_adapter.rs` - WebSocket 消息监听
- `src/services/events.ts` - 前端事件定义
- `src/features/ui/index.ts` - UI 渲染
- `src/types.ts` - ModelOption 类型定义

---

**文档历史**

| 版本 | 日期 | 修改内容 |
|------|------|----------|
| v1.0 | 2026-03-13 | 合并两份文档为最终版 |
