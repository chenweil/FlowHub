# 能力中心草案 Review

| 项目 | 内容 |
|---|---|
| 审阅对象 | `2026-03-16-capability-center-a-to-b-structure-draft.md` |
| 日期 | 2026-03-16 |

---

## 总体评价

结构清晰，A/B 分阶段策略合理，Runtime First 避免了解析各家 CLI 配置的复杂度。持久化设计克制，验收标准可衡量。

以下是需要进一步明确的 6 个问题，按优先级排列。

---

## 问题 1（高）：SkillRuntimeItem 数据结构缺失

### 现状

文档定义了 `skillRuntimeByAgentType: Record<string, SkillRuntimeItem[]>`，但没有给出 `SkillRuntimeItem` 的字段定义。

对比 MCP 已有明确的类型：

```ts
// 现有代码 src/types.ts
interface RegistryMcpServer {
  name: string;
  description: string;
}
```

### 需要回答

- `SkillRuntimeItem` 包含哪些字段？至少需要：`name`、`description`、`enabled`？
- skill 目录（`~/.iflow/skills`）下每个 skill 的 manifest 是什么格式？JSON / YAML / markdown frontmatter？
- 扫描逻辑：是遍历子目录找 manifest，还是扫描单文件？

### 建议

补充类似定义：

```ts
interface SkillRuntimeItem {
  name: string;           // 技能标识（去重 key）
  description: string;    // 展示描述
  source: string;         // 来源路径，如 ~/.iflow/skills/foo
  // B 阶段预留
  // version?: string;
  // healthStatus?: 'ok' | 'error' | 'unknown';
}
```

同时定义 skill manifest 的最小格式约定。

---

## 问题 2（高）：MCP 开关的语义不明确

### 现状

验收标准写："关闭后对应项不再进入 slash 建议列表"。

看现有代码，slash 菜单从 `state.registryByAgent[agentId].mcpServers` 构建 `category: 'mcp'` 的菜单项：

```ts
// src/features/app.ts - buildSlashMenuItemsForCurrentAgent()
// MCP servers 作为 slash menu item 展示
```

### 问题

"关闭 MCP" 是什么语义？

| 选项 | 效果 | 复杂度 |
|------|------|--------|
| A. UI 隐藏 | slash 菜单不显示，但 Agent 仍可调用该 MCP | 低 |
| B. 真正禁用 | 通知 Agent 后端不加载该 MCP server | 高，需要改 CLI 配置 |

选项 A 与草案 "非目标：不改写 CLI 配置" 一致，但用户可能误以为 MCP 被真正禁用。

### 建议

A 阶段选方案 A（UI 隐藏），但需要：
1. 在 UI 上明确标注 "隐藏" 而非 "禁用"
2. 或者 A 阶段的开关就叫 "在建议列表中显示"，语义更准确

---

## 问题 3（高）：Skill 目录 manifest 格式未定义

### 现状

`discover_skills({ agentType: "iflow" })` 扫描 `~/.iflow/skills`，但没有说明：

- 目录结构是什么？`~/.iflow/skills/my-skill/` 还是 `~/.iflow/skills/my-skill.md`？
- 如何从文件中提取 name / description？

### 需要回答

是否参考已有格式？例如 Claude Code 的 skill 是 markdown + frontmatter：

```markdown
---
name: my-skill
description: Does something useful
---
Skill content here...
```

还是自定义 JSON manifest：

```json
{
  "name": "my-skill",
  "description": "Does something useful",
  "entry": "index.md"
}
```

### 建议

在文档中补充一个 "Skill 目录约定" 章节，定义最小 manifest 格式。A 阶段只需读取 name + description 用于列表展示即可。

---

## 问题 4（中）：agentType 共享 skill 开关是否为预期行为

### 现状

```
MCP 开关维度:   agentId      → 每个 agent 独立
SKILL 开关维度: agentType    → 同类型 agent 共享
```

### 场景

用户有两个 iflow agent（agent-A 指向项目 X，agent-B 指向项目 Y）。在 agent-A 的能力中心关闭 skill-foo，切到 agent-B 时 skill-foo 也被关闭。

### 问题

- 这是 feature（同类型 agent 共享 skill 配置）还是 surprise（用户预期每个 agent 独立）？
- 如果是 feature，UI 上需要提示 "此设置对所有 iflow 类型 agent 生效"

### 建议

明确标注这是预期行为，或改为 agentId 维度保持一致性。两种都合理，但需要做出选择并记录理由。

---

## 问题 5（中）：独立弹窗 vs 设置内嵌

### 现状

草案选择 "独立弹窗"，设置弹窗新增 "前往能力中心" 入口。

当前设置弹窗结构（`index.html:214-312`）：

```
设置弹窗
├── 刷新后重连
├── 提醒
├── 输入
└── 外观
```

### 代价

独立弹窗意味着：
- index.html 新增一整块 modal HTML（Tab 切换 + MCP 列表 + SKILL 列表）
- dom.ts 新增一批 DOM 元素引用
- 弹窗间导航逻辑（设置 → 能力中心 → 返回设置？直接关闭？）

### 替代方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| 独立弹窗 | B 阶段空间大，内容不受设置弹窗约束 | 多一层弹窗概念，导航复杂 |
| 设置内嵌 Tab | 入口统一，不增加新弹窗 | 设置弹窗膨胀，B 阶段可能放不下 |
| 独立页面/面板 | 空间最大，可做复杂布局 | 改动最大，偏离当前弹窗模式 |

### 建议

如果 B 阶段确定会有安装/更新/权限/日志等重功能，独立弹窗是对的。否则设置内嵌更简单。请明确选择理由。

---

## 问题 6（中）：refresh_capabilities 中 MCP 数据的获取路径

### 现状

后端接口 `refresh_capabilities({ agentId, agentType })` 返回 `{ mcp, skills }`。

但现有 MCP 数据流是：

```
Agent 运行时上报 → onCommandRegistry 事件 → applyAgentRegistry() → state.registryByAgent
```

这是 Agent 主动推送的，Tauri 后端并不持有 MCP 列表。

### 问题

`refresh_capabilities` 如何获取 MCP 数据？

| 选项 | 说明 |
|------|------|
| A. Tauri 转发请求给 Agent | 需要新增 Agent 通信协议 |
| B. 前端直接用 state 中已有数据 | refresh 只刷新 skills，MCP 用缓存 |
| C. Tauri 解析 Agent 配置文件 | 与 "Runtime First" 策略矛盾 |

### 建议

A 阶段简化：`refresh_capabilities` 只刷新 skills，MCP 数据继续走现有的 `registryByAgent` 事件流。前端合并两个来源展示即可。无需为 MCP 新增刷新接口。
