# 能力中心设计文档评审

| 项目 | 内容 |
|---|---|
| 评审日期 | 2026-03-16 |
| 评审模型 | OpenCode + GLM-5 |
| 原文档 | `docs/plans/2026-03-16-capability-center-a-to-b-structure-draft.md` |
| 原文版本 | v0.2 |

---

## 设计文档点评

### ✅ 优点

1. **分阶段策略清晰**：A阶段聚焦核心功能（列表+开关），B阶段预留扩展点，避免了过度设计

2. **语义明确**：v0.2 新增第2节"关键语义决议"，明确开关仅控制"建议可见性"，不承诺真实禁用

3. **数据来源策略合理**：
   - MCP 采用 Runtime First 避免解析多种 CLI 配置
   - SKILL 扫描固定目录 `~/.iflow/skills`，简单可控

4. **状态模型设计完整**：
   - `mcpEnabledByAgent` / `skillEnabledByAgentType` 分离
   - 新增 `capabilityErrors` 错误态字段
   - 类型定义 `McpRuntimeItem` / `SkillRuntimeItem` 清晰

5. **Skill 目录契约明确**：第5节定义了 SKILL.md 解析规则和失败处理

6. **与现有代码衔接点明确**：第9节准确指出了需要修改的文件

7. **实施顺序细化**：从 3 PR 拆分为 5 PR，粒度更合理

---

### ✅ v0.2 改进确认

| 改进点 | 状态 |
|--------|------|
| 开关语义澄清（仅影响建议列表） | ✅ 已解决 |
| 持久化 key 语义化命名 | ✅ 改为 `iflow-capability-enables-v1` |
| 错误处理设计 | ✅ 新增 `capabilityErrors` + 验收标准 |
| SKILL 数据来源 | ✅ 明确 A 阶段仅支持 iflow |
| 离线策略 | ✅ 新增"上次已知列表（只读）+ 离线标记" |

---

### 📝 实施注意事项

#### 1. PR1 状态模型细节

```typescript
// src/store.ts 新增字段
interface CapabilityState {
  // 运行时数据
  mcpRuntimeByAgent: Record<string, McpRuntimeItem[]>;
  skillRuntimeByAgentType: Record<string, SkillRuntimeItem[]>;
  
  // 开关状态（持久化）
  mcpEnabledByAgent: Record<string, Record<string, boolean>>;
  skillEnabledByAgentType: Record<string, Record<string, boolean>>;
  
  // UI 状态
  capabilityCenterTab: 'mcp' | 'skill';
  capabilityLoading: boolean;
  capabilityErrors: Record<string, string>;
}
```

#### 2. Slash 菜单过滤位置

`src/features/app.ts:732` 的 `buildSlashMenuItemsForCurrentAgent()` 需要增加过滤：

```typescript
// MCP 过滤
currentRegistry?.mcpServers
  .filter((entry) => isMcpSuggestionEnabled(state.currentAgentId, entry.name))
  .forEach(...)

// SKILL 过滤（PR4 新增）
skillRuntimeItems
  .filter((skill) => isSkillSuggestionEnabled('iflow', skill.skillName))
  .forEach(...)
```

#### 3. Skill 扫描 Rust 接口

```rust
// src-tauri/src/main.rs
#[tauri::command]
async fn discover_skills(agent_type: String) -> Result<Vec<SkillRuntimeItem>, String> {
    if agent_type != "iflow" {
        return Err("A阶段仅支持 iflow agent type".to_string());
    }
    let skills_dir = dirs::home_dir()
        .ok_or("无法获取用户目录")?
        .join(".iflow")
        .join("skills");
    // 扫描逻辑...
}
```

#### 4. SKILL.md frontmatter 解析

```typescript
// 建议使用 gray-matter 或简易正则解析
interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function parseSkillMarkdown(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  // 解析 YAML...
}
```

---

### ⚠️ 待确认

#### 问题 1：离线缓存的存储位置

第6节提到 `mcpRuntimeByAgent` 含离线缓存，但第7节持久化模型未包含此字段。

**确认**：离线缓存是否也持久化到 localStorage？还是仅在内存中保留？

#### 问题 2：错误展示 UI 细节

`capabilityErrors` 字段记录错误，但验收标准未定义错误展示的具体样式。

**建议**：在能力中心列表项旁显示错误图标 + tooltip，或底部显示错误汇总区域。

---

## 下一步行动

| 优先级 | 任务 |
|--------|------|
| P0 | 确认离线缓存存储策略 |
| P1 | 开始 PR1：状态模型 + 持久化 + 过滤函数 |
| P2 | 设计能力中心 UI 原型（可并行） |

---

## 附录：PR 划分建议

| PR | 内容 | 预估复杂度 |
|----|------|-----------|
| PR1 | 状态模型 + 持久化 + 过滤函数 | 低 |
| PR2 | 能力中心 UI 壳 + MCP 列表 | 中 |
| PR3 | MCP 建议可见性开关 + slash 过滤 | 低 |
| PR4 | discover_skills + SKILL 列表与开关 | 高 |
| PR5 | 刷新机制 + 离线态/空态/错误态 | 中 |
