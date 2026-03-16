# 能力中心（MCP / SKILL）A->B 结构草案

| 项目 | 内容 |
|---|---|
| 版本 | v0.2 |
| 日期 | 2026-03-16 |
| 状态 | 草案（已吸收三份 review） |
| 背景 | 当前设置为轻量弹窗；目标是先做 A（列表+开关），最终做到 B（安装/更新/权限/测试/日志） |

## 1. 目标与范围

| 项目 | 内容 |
|---|---|
| A阶段目标 | 提供 MCP / SKILL 列表、建议可见性开关、基础状态展示 |
| B阶段目标 | 增加安装/更新/卸载、权限管理、连接测试、日志与错误分析 |
| 本次范围 | 仅定义 A 阶段可落地结构，并预留 B 阶段扩展位 |
| 非目标 | A 阶段不直接改写各类 Agent CLI 的 MCP 配置文件，不承诺“真实禁用” |

## 2. 关键语义决议（A阶段）

| 决议项 | 最终约定 |
|---|---|
| MCP/SKILL 开关语义 | 仅控制“是否显示在 slash 建议列表”，不代表运行时真实禁用 |
| 手动输入命令 | 即使关闭建议显示，用户手动输入命令仍可能执行 |
| Skill 数据来源 | 当前仅支持 `iflow`，只扫描 `~/.iflow/skills` |
| MCP 刷新路径 | 继续使用现有 runtime 事件流 `registryByAgent`，不新增后端 MCP 拉取接口 |
| 离线策略 | 展示“上次已知列表（只读）+ 离线标记” |

## 3. 信息架构

| 区域 | 设计 |
|---|---|
| 设置弹窗 | 保持轻设置（主题/通知/快捷键），新增“前往能力中心”入口 |
| 能力中心 | 独立弹窗，包含 `MCP` / `SKILL` 两个 Tab |
| MCP 数据来源 | 当前连接 Agent 的运行时注册数据（runtime） |
| SKILL 数据来源 | 按当前 Agent 类型扫描生效目录；A 阶段 `iflow` 固定为 `~/.iflow/skills` |

## 4. 扫描与来源策略（A阶段）

| 能力类型 | 策略 | 说明 |
|---|---|---|
| MCP | Runtime First | 以 Agent 已加载并上报的数据为准，避免直接解析多种 CLI 配置 |
| SKILL | Agent-Type First | 当前仅支持 `iflow` |
| Skill 扫描目录 | 固定目录 | `~/.iflow/skills` |
| 通用目录 | 暂不启用 | `~/.agents/skills` 等目录留到 B 阶段做“仓库/安装器”能力 |
| 去重规则 | 名称去重（大小写不敏感） | MCP 按 `serverName`；SKILL 按 `skillName`；展示使用原始大小写 |

## 5. Skill 目录契约（A阶段）

| 项目 | 约定 |
|---|---|
| 目录结构 | `~/.iflow/skills/<skill-dir>/SKILL.md` |
| 识别条件 | 子目录中存在 `SKILL.md` 即识别为一个 skill |
| 名称来源 | 优先读取 `SKILL.md` frontmatter `name`；缺失则回退目录名 |
| 描述来源 | 优先读取 frontmatter `description`；缺失则为空字符串 |
| 解析失败处理 | 记录错误并跳过该 skill，其他 skill 继续扫描 |

## 6. 状态模型草案

| 字段 | 类型 | 说明 |
|---|---|---|
| `mcpRuntimeByAgent` | `Record<string, McpRuntimeItem[]>` | 每个 Agent 的 MCP 运行时列表（含离线缓存） |
| `skillRuntimeByAgentType` | `Record<string, SkillRuntimeItem[]>` | 按 Agent 类型缓存技能扫描结果 |
| `mcpEnabledByAgent` | `Record<string, Record<string, boolean>>` | MCP 建议可见性开关（按 Agent 维度） |
| `skillEnabledByAgentType` | `Record<string, Record<string, boolean>>` | SKILL 建议可见性开关（按 Agent 类型） |
| `capabilityCenterTab` | `'mcp' \| 'skill'` | 当前 Tab |
| `capabilityLoading` | `boolean` | 能力中心加载态 |
| `capabilityErrors` | `Record<string, string>` | 扫描/读取错误信息（按能力分区） |

| 类型 | 字段 |
|---|---|
| `McpRuntimeItem` | `agentId` `serverName` `description` `source: "runtime"` `discoveredAt` `online: boolean` |
| `SkillRuntimeItem` | `agentType` `skillName` `title` `description` `path` `source: "iflow-cli-dir"` `discoveredAt` |

## 7. 持久化模型

| 项目 | 内容 |
|---|---|
| Key | `iflow-capability-enables-v1` |
| 持久化内容 | `mcpEnabledByAgent`、`skillEnabledByAgentType`、`updatedAt` |
| 不持久化内容 | 安装状态、扫描结果、健康状态（统一实时刷新） |

## 8. 后端接口草案（Tauri）

| 命令 | 入参 | 返回 | 用途 |
|---|---|---|---|
| `discover_skills` | `{ agentType: "iflow" }` | `SkillRuntimeItem[]` | 扫描 `~/.iflow/skills` |
| `refresh_capabilities` | `{ agentType: "iflow" }` | `{ skills: SkillRuntimeItem[] }` | 手动刷新技能列表 |

| 说明 | 内容 |
|---|---|
| MCP 刷新 | A 阶段不提供后端 MCP 拉取；前端继续消费 `registryByAgent` runtime 数据 |

## 9. 与现有代码衔接点

| 文件 | 衔接设计 |
|---|---|
| `src/features/agents/registry.ts` | 继续作为 MCP runtime 数据入口（不改变现有协议） |
| `src/features/app.ts` | `buildSlashMenuItemsForCurrentAgent()` 中过滤建议可见性为 `false` 的 MCP/SKILL 项 |
| `src/store.ts` | 增加 capability state、离线缓存、错误态与持久化读写 |
| `index.html` | 新增“能力中心”弹窗结构与入口按钮 |

## 10. A阶段验收标准

| 类别 | 标准 |
|---|---|
| 可发现性 | 用户可在 3 次点击内进入能力中心并找到 MCP/SKILL 开关 |
| 功能性 | 关闭后对应项不再进入 slash 建议列表 |
| 语义清晰 | UI 明确标注“仅影响建议列表显示，不代表真实禁用” |
| 错误处理 | 技能目录不存在、无权限、解析失败均有明确提示/空态 |
| 持久化 | 重启应用后开关状态保持 |
| 回归安全 | 不影响现有设置弹窗、会话与消息主流程 |

## 11. A->B 扩展预留

| 预留点 | B阶段用途 |
|---|---|
| `source` / `installedFrom` 字段 | 区分 runtime、仓库安装、手动链接来源 |
| `healthStatus` / `lastError` | 展示可用性检测与错误信息 |
| `version` | 版本追踪与更新提示 |
| Provider 抽象 | 支持多 Agent CLI（iflow/codex/claude 等） |
| 配置写回流程 | 支持 diff 预览、备份、应用、回滚 |
| 全局覆盖层 | 在 `agent` 维度之上增加全局启用/禁用策略 |

## 12. 实施顺序建议

| 阶段 | 内容 |
|---|---|
| PR1 | 状态模型 + 持久化 + 过滤函数（不改 UI） |
| PR2 | 能力中心 UI 壳 + MCP 列表（只读） |
| PR3 | MCP 建议可见性开关 + slash 过滤 |
| PR4 | `discover_skills(iflow)` + SKILL 列表与开关 |
| PR5 | 刷新机制 + 离线态/空态/错误态 + 单测 |
