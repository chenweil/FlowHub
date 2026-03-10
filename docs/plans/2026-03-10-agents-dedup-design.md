# Agents Dedup Design

**日期：** 2026-03-10

## 目标

- 收敛重复逻辑，确保单一来源（Single Source of Truth）。
- 保持现有行为不变，仅做结构性去重与引用调整。

## 范围

- 自动重连模式的默认值与归一化逻辑统一到 `src/features/agents/reconnect.ts`。
- 模型选项归一化逻辑统一到 `src/features/agents/model.ts`。
- 其他模块仅改为调用与导出，不再重复实现。

## 非目标

- 不改变自动重连/模型切换的现有行为与 UI 表现。
- 不引入新的架构模式或技术栈。
- 不处理与本次去重无关的 UI/功能改动。

## 方案（采用 A）

- 保留 `reconnect.ts` 与 `model.ts` 作为唯一来源。
- `app.ts`、`commands.ts`、`registry.ts` 等改为引用或导出统一函数/常量。

## 文件改动（预期）

- `src/features/agents/reconnect.ts`
  - 导出 `AUTO_RECONNECT_MODE_DEFAULT` 与 `normalizeAutoReconnectMode`（如需）。
- `src/features/app.ts`
  - 移除本地 `normalizeAutoReconnectMode` 与默认值，改为引用。
- `src/features/agents/commands.ts`
  - 移除本地默认值，改为引用统一默认值。
- `src/features/agents/registry.ts`
  - 移除本地 `normalizeModelOption`，改为从 `model.ts` 引用。
- `src/features/agents/index.ts`
  - 维护统一导出（确保对外接口不变）。

## 行为与兼容性

- 行为保持一致，不新增/删除功能。
- 仅统一来源，减少未来分叉风险。

## 测试策略

- 若已有测试框架，则补充针对去重逻辑的单测。
- 若无测试框架，则在后续实现计划中明确最小可行的测试引入方案。

