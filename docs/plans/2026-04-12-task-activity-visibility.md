# Task Activity Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让长任务在界面上明确显示“仍在推进”还是“疑似卡住”，并把最近一次工具调用名称暴露给用户。

**Architecture:** 复用现有 inflight/task/tool-call 事件，不改协议。前端新增一层轻量运行态，统一驱动输入框下方状态提示和“更多 -> 工具”面板顶部摘要。通过定时刷新把“几秒前有新动作”变成实时文案。

**Tech Stack:** TypeScript、Vitest、现有 Tauri 事件流、现有工具调用侧栏。

---

### Task 1: 增加可测试的活动状态文案逻辑

**Files:**
- Create: `src/features/agents/activity.ts`
- Create: `src/features/agents/activity.test.ts`
- Modify: `src/types.ts`

**Step 1: Write the failing test**

覆盖：
- 忙碌且刚有动作时显示“刚刚有新动作”
- 忙碌且超过阈值时显示“可能卡住”
- 带最近工具名时拼接 `最近工具：xxx`

**Step 2: Run test to verify it fails**

Run: `npm test`

**Step 3: Write minimal implementation**

新增纯函数：
- `recordAgentActivity(...)`
- `buildBusyActivityHint(...)`
- `buildToolPanelActivitySummary(...)`

**Step 4: Run test to verify it passes**

Run: `npm test`

### Task 2: 将活动状态接到现有事件流

**Files:**
- Modify: `src/store.ts`
- Modify: `src/features/app.ts`

**Step 1: Write/extend failing test**

用 activity 纯函数测试保证状态文案正确，避免直接写 DOM 级大测试。

**Step 2: Implement minimal wiring**

在这些事件中刷新活动状态：
- `stream-message`
- `tool-call`
- `task-finish`
- `agent-error`
- `sendMessage()` 发送开始

并在 app 初始化时加一个 1 秒 ticker 仅用于刷新忙碌态提示。

**Step 3: Run verification**

Run: `npm test`

### Task 3: 增强工具面板显示

**Files:**
- Modify: `src/features/ui/index.ts`
- Modify: `src/features/agents/tool-calls.ts`
- Modify: `src/styles.css`

**Step 1: Implement summary block**

在工具面板顶部增加一个状态摘要块，显示：
- 当前是否活跃
- 距最近动作多久
- 最近工具名

**Step 2: Keep existing list behavior**

不要改掉现有工具列表，只在顶部插入摘要。

**Step 3: Verify**

Run: `npm run build`

### Task 4: 集成验证并启动新环境

**Files:**
- Modify: `src/main.ts`（如需初始化 ticker）

**Step 1: Run all checks**

Run:
- `npm test`
- `cd src-tauri && cargo test`
- `npm run build`

**Step 2: Restart dev app**

Run:
- `npm run kill`
- `npm run tauri:dev`

**Step 3: Manual verification**

检查：
- 长任务中输入框下方出现“几秒前有新动作”
- 超过阈值后切换到“可能卡住”
- “更多 -> 工具”面板顶部出现相同摘要
- 工具名称会随着最近一次工具调用更新
