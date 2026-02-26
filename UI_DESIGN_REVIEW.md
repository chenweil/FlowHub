# UI 设计与配色审查报告

> 文件：`src/styles.css` + `index.html`
> 日期：2026-02-27

---

## 一、现状总结

**整体风格**：直接移植了 GitHub Dark 配色体系（`#0d1117`, `#161b22`, `#2f81f7` 等），整体干净，但缺乏产品自身识别度。

**已做得好的地方**：
- CSS 变量体系结构清晰（`:root` 定义了完整的颜色和圆角变量）
- 字体栈使用系统字体，渲染性能好
- 交互状态（hover / active / disabled）覆盖基本完整
- Scrollbar 自定义样式统一

---

## 二、问题清单

### 🔴 高优先级

#### 2.1 输入区背景层次是反的

```css
/* 当前 */
.main-content    { background: var(--bg-primary); }   /* #0d1117 最深 */
.input-container { background: var(--bg-secondary); } /* #161b22 比内容区亮 */
#message-input   { background: var(--bg-primary); }   /* #0d1117 又变深 */
```

输入容器比聊天区域亮，像是悬浮，但 input 本身又更深，层次感混乱。

**修复方案**：
```css
.input-container { background: var(--bg-primary); }
#message-input   { background: var(--bg-secondary); } /* 输入框比背景略亮，符合自然层次 */
```

---

#### 2.2 success-color 对比度不足

`--success-color: #238636` 在深色背景上作为文字颜色时对比度约 3.5:1，低于 WCAG AA 标准（4.5:1）。

影响位置：
- `badge.connected` 的文字颜色
- `status-dot.connected`

**修复方案**：
```css
:root {
  --success-color: #238636;   /* 背景/边框用 */
  --success-text:  #3fb950;   /* 文字用，对比度 ~5.5:1 */
}

/* badge.connected */
.badge.connected { color: var(--success-text); }
```

---

#### 2.3 缺少全局 focus ring

大多数 button/input 缺少键盘导航时的可见焦点轮廓，影响无障碍访问。

**修复方案**：
```css
:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}
/* 清除旧的 outline: none */
#message-input:focus { outline: none; } /* 这行可改为 focus-visible */
```

---

### 🟡 中优先级

#### 2.4 硬编码颜色散落各处

CSS 变量体系存在，但大量颜色绕开变量直接写魔法值：

| 位置 | 魔法值 | 语义 |
|------|--------|------|
| `.md-code-block` | `#0b0f14` | 代码块背景 |
| `#message-input.composer-busy` | `#11161d` | 忙碌状态输入框背景 |
| `.model-selector-caret` | `#6e7681` | 次要文字（更暗） |
| `.agent-item .agent-meta` | `#6e7681` | 同上 |
| `.thought-details summary` | `#9aa4af` | 思考摘要文字 |
| `.thought-text` | `#aeb8c2` | 思考正文文字 |
| `.message.thought .message-avatar` | `#57606a` | 思考气泡头像 |

**修复方案**：新增变量并替换：
```css
:root {
  --bg-code:      #0b0f14;   /* 代码块背景（比 bg-primary 更深） */
  --bg-busy:      #11161d;   /* 忙碌状态背景 */
  --text-muted:   #6e7681;   /* 三级文字 */
  --text-subtle:  #9aa4af;   /* 四级文字（思考类） */
}
```

---

#### 2.5 Modal 无过渡动画，体验生硬

弹窗直接切换 `display: none` ↔ `flex`，无任何动效。

**修复方案**：
```css
.modal {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  display: flex; /* 始终 flex，用 opacity 控制显隐 */
}

.modal:not(.hidden) {
  opacity: 1;
  pointer-events: auto;
}

.modal-content {
  transform: translateY(-8px) scale(0.98);
  transition: transform 0.15s ease;
}

.modal:not(.hidden) .modal-content {
  transform: translateY(0) scale(1);
}
```

> 注意：JS 里需要把 `element.classList.toggle('hidden')` 的逻辑保留，只是 CSS 的 `.hidden` 不再用 `display: none`。

---

#### 2.6 accent 与 purple gradient 使用不一致

Logo 标题用了 blue → purple 渐变，但全局 accent 是纯蓝，两者关联感弱，未形成品牌色系统。

**方向 A（简化）**：去掉 Logo 渐变，统一用 `--accent-color`。

**方向 B（品牌化）**：将 purple 纳入变量，系统性使用：
```css
:root {
  --accent-secondary: #a371f7;
  --accent-gradient: linear-gradient(135deg, var(--accent-color), var(--accent-secondary));
}

/* 可用于 agent-icon、active highlight 等 */
.agent-item .agent-icon { background: var(--accent-gradient); }
.sidebar-header h1      { background: var(--accent-gradient); }
```

---

### 🟢 低优先级

#### 2.7 代码块背景过暗

`.md-code-block` 背景 `#0b0f14` 比页面背景 `#0d1117` 还暗，视觉上像"黑洞"，且缺少语言标签和语法高亮。

**修复建议**：
- 背景改为 `var(--bg-tertiary)`（`#21262d`），与整体层次一致
- 添加语言标签头部（HTML 层面）
- 按需引入 [Shiki](https://shiki.matsu.io/)（支持 GitHub Dark 主题，零运行时）

#### 2.8 Scrollbar 过宽

8px 在窄面板（session-section、tool-calls-list）里占比明显。

```css
::-webkit-scrollbar { width: 4px; }
```

#### 2.9 无 light mode 支持

当前无 `@media (prefers-color-scheme: light)` 支持，系统切换浅色模式时体验较差。

---

## 三、优先级汇总

| # | 问题 | 优先级 | 预估工作量 |
|---|------|--------|-----------|
| 2.1 | 输入区背景层次反转 | 🔴 高 | ✅ 已完成 |
| 2.2 | success-color 对比度不足 | 🔴 高 | ✅ 已完成 |
| 2.3 | 缺少全局 focus ring | 🔴 高 | ✅ 已完成 |
| 2.4 | 硬编码颜色整理 | 🟡 中 | ✅ 已完成 |
| 2.5 | Modal 过渡动画 | 🟡 中 | ✅ 已完成 |
| 2.6 | 品牌色系统化 | 🟡 中 | ✅ 已完成 |
| 2.7 | 代码块样式优化 | 🟢 低 | ✅ 已完成 |
| 2.8 | Scrollbar 宽度 | 🟢 低 | ✅ 已完成 |
| 2.9 | Light mode 支持 | 🟢 低 | ⏭️ 跳过（较大，单独排期）|
