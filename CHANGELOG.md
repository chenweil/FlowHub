# Changelog

本项目变更记录遵循以下约定：

- 参考 Keep a Changelog 结构
- 版本号遵循 Semantic Versioning（SemVer）
- 每次更新优先记录到 `Unreleased`，发布时再归档到具体版本

## [Unreleased]

### Added

- 顶部工具栏新增模型选择器，支持显示当前模型、展开模型列表、点击切换模型。
- 新增 ACP 模型元数据事件同步：后端解析 `session/new` / `session/load` 返回的 `_meta.models` 并推送到前端。
- 对话区新增快捷交互按钮：
  - 助手最后一条消息下显示“继续 / 好的 / 重试上一问”；
  - 用户最后一条消息下显示“重试发送”。

### Changed

- 模型切换链路改为“ACP 优先 + 重启兜底”：
  - 优先调用 `session/set_model`，减少切换中断；
  - ACP 不可用时自动回退到重启进程并通过 `--model` 切换。
- 模型列表获取兼容增强：后端支持从 `iflow.js` / `entry.js` 解析模型常量。
- 工具调用面板改为按 `toolCallId` 增量合并，不再每条事件全量覆盖。

### Fixed

- 修复工具调用在状态变为 `completed` 后内容闪烁/丢失的问题（例如 `web_search` 查询内容被覆盖）。
- 修复工具调用面板只能显示最后一条的问题，改为支持同一轮显示多条调用记录。
- 修复输入 `/` 后使用键盘上下键移动时，命令列表未自动滚动到高亮项的问题。

## [0.1.0] - 2026-02-25

### Added

- 初始版本：Tauri + TypeScript 的 iFlow Workspace 基础能力。
