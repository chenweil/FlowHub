# 能力中心（MCP / SKILL）设计点评

**Review 日期**: 2026-03-16  
**Reviewer**: iFlow K2.5  
**Review 对象**: `2026-03-16-capability-center-a-to-b-structure-draft.md`

---

## 总体印象

这份设计文档**结构清晰、思路务实**，A->B 渐进式的策略非常合理。文档作者考虑了与现有代码的良好衔接，整体架构设计成熟。

---

## 亮点

| 方面 | 评价 |
|------|------|
| **渐进式策略** | A->B 的分阶段思路降低了实施风险，A 阶段聚焦核心功能 |
| **Runtime First** | MCP 采用运行时数据而非直接解析 CLI 配置，避免了多格式兼容的复杂性 |
| **状态模型** | `mcpEnabledByAgent` 等字段设计合理，按 Agent 维度管理很符合现有架构 |
| **衔接点明确** | 清晰列出了与 `registry.ts`、`app.ts`、`store.ts` 的衔接方式 |
| **持久化设计** | 只持久化开关状态，运行时数据实时刷新，避免数据不一致 |

---

## 潜在问题与改进建议

### 1. Agent 离线时的 MCP 状态问题 ⚠️

**问题**：采用 Runtime First 策略，当 Agent 离线后，MCP 列表会消失，但用户的开关设置还在。再次连接时，可能出现"开关开着但列表里看不到"的困惑。

**建议**：
- 考虑缓存最后一次的 MCP 列表（只读展示，标记为"离线"状态）
- 或者 UI 上明确区分"当前可用" vs "上次已知"

---

### 2. SKILL 目录的 Agent 类型扩展性 ⚠️

**问题**：当前只扫描 `~/.iflow/skills`，但用户可能使用 codex、claude 等其他 Agent。

**建议**：
- 文档中提到 B 阶段才做 `~/.agents/skills`，但 A 阶段可以考虑把 `agentType` 参数用起来
- 或者 A 阶段明确限定只支持 iflow，文档中说明这是已知限制

---

### 3. 去重规则的潜在冲突 ⚠️

当前去重规则：
- MCP 按 `serverName` 
- SKILL 按 `skillName`

**问题**：大小写不敏感去重是合理的，但如果两个 MCP 只有大小写不同（如 `GitHub` vs `github`），可能会有预期外的行为。

**建议**：
- 明确是否保留大小写显示但去重时忽略
- 考虑在 UI 上显示完整的原始名称

---

### 4. 全局开关 vs Agent 级别开关 🤔

**问题**：`mcpEnabledByAgent` 是按 Agent 的，但用户可能想要"全局禁用某个 MCP"（比如某个 MCP 有 bug，想在所有 Agent 中关闭）。

**建议**：
- A 阶段可以保持 Agent 级别
- 但在 B 阶段预留扩展，考虑增加全局覆盖层

---

### 5. 与现有 slash 命令的集成细节 ⚠️

当前设计提到"在 slash 菜单构建流程中过滤"，但需要明确：

- 过滤是在 `buildSlashMenuItemsForCurrentAgent()` 中进行吗？
- 过滤后 MCP 命令是完全消失，还是显示为禁用状态？
- 如果 MCP 被禁用，用户是否还能通过手动输入 `/mcp get xxx` 使用？

**建议**：
- 明确过滤逻辑的位置
- 考虑在 UI 上给禁用的 MCP 一个"已禁用"标记而不是完全隐藏（提升可发现性）

---

### 6. 缺少 UI 交互细节 📝

A 阶段虽然是 MVP，但一些基础交互需要定义：

- 能力中心弹窗的打开/关闭方式？
- 列表是否支持搜索/过滤？
- 空状态（没有 MCP/SKILL）如何处理？
- 加载状态的展示？

**建议**：
- 补充简单的 UI 流程描述
- 或者明确这部分留给实现时细化

---

### 7. B 阶段扩展预留的完整性 🤔

预留字段中提到了 `source`、`installedFrom`、`healthStatus`，但缺少：

- **版本信息**：MCP/Skill 的版本如何追踪？
- **配置参数**：有些 MCP 需要配置（如 API Key），A 阶段完全不支持配置吗？
- **依赖关系**：Skill 可能依赖某些 MCP，这种关系如何处理？

---

## 代码衔接的具体建议

根据现有代码分析，有以下几个具体建议：

### 1. `registry.ts`

目前的 `RegistryMcpServer` 只有 `name` 和 `description`，建议：
- 保持类型简单，enabled 状态在 store 中管理
- 或者增加可选的 `enabled` 字段作为运行时状态缓存

### 2. `store.ts`

新增的 capability state 建议放在 `registryByAgent` 旁边，保持逻辑聚合：

```typescript
// 建议新增字段位置
export const state = {
  // ... 原有字段
  registryByAgent: {} as Record<string, AgentRegistry>,
  
  // 新增：能力中心相关状态
  mcpEnabledByAgent: {} as Record<string, Record<string, boolean>>,
  skillEnabledByAgentType: {} as Record<string, Record<string, boolean>>,
  capabilityCenterTab: 'mcp' as 'mcp' | 'skill',
  capabilityLoading: false,
  // ...
};
```

### 3. `app.ts` 中的 `buildSlashMenuItemsForCurrentAgent()`

需要修改这个函数来支持过滤：

```typescript
currentRegistry?.mcpServers.forEach((entry, index) => {
  // 检查是否被禁用
  if (isMcpDisabled(state.currentAgentId!, entry.name)) {
    return; // 或者添加禁用标记
  }
  // ... 原有逻辑
});
```

---

## 实施顺序的调整建议

### 原计划的 PR 顺序

1. UI 壳 + 状态模型 + MCP 开关过滤
2. `discover_skills` + SKILL 列表
3. 刷新机制 + 空状态/错误态 + 单测

### 建议调整为

1. **PR1**: 状态模型 + store 扩展 + 持久化（无 UI）
2. **PR2**: 能力中心 UI 壳 + MCP 列表展示（只读，无开关）
3. **PR3**: MCP 开关功能 + slash 菜单过滤
4. **PR4**: SKILL 扫描 + 列表 + 开关
5. **PR5**: 刷新机制 + 错误处理 + 单测

**调整理由**：
- PR1 先打基础，便于后续并行开发
- PR2-PR3 分步验证 MCP 功能，降低每个 PR 复杂度
- PR4 再扩展 SKILL，保持增量交付

---

## 综合评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 完整性 | ⭐⭐⭐⭐☆ | 架构清晰，但缺少一些 UI 和错误处理细节 |
| 可行性 | ⭐⭐⭐⭐⭐ | A 阶段范围控制得很好，风险低 |
| 扩展性 | ⭐⭐⭐⭐☆ | B 阶段预留较充分，但版本/配置可考虑 |
| 与现有代码衔接 | ⭐⭐⭐⭐⭐ | 衔接点明确，改动范围可控 |

**总体评价**：这是一份**高质量的设计文档**，A->B 的策略很聪明。主要需要在 Agent 离线状态、全局开关、UI 交互细节上做一些补充，就可以进入实现了。

---

## 下一步建议

1. **补充 UI 交互流程**：明确能力中心的打开方式、列表展示形式、空状态处理
2. **明确 Agent 离线策略**：决定是否缓存最后一次的 MCP 列表
3. **细化 slash 菜单过滤逻辑**：完全隐藏 vs 显示为禁用
4. **确认 SKILL 的 A 阶段范围**：是否只支持 iflow，codex/claude 如何处理
5. **进入实施**：基于调整后的 PR 顺序开始编码
