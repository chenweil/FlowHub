# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## Project Overview

Flow Hub is a Multi-Agent Desktop App built with Tauri 2.0. It connects to iFlow CLI agents via the ACP (Agent Communication Protocol) over WebSocket, providing chat, session management, model switching, tool call visualization, and git diff inspection.

**Tech Stack:** TypeScript (no framework) + Vite | Rust + Tauri 2.0 + Tokio + tokio-tungstenite

**Prerequisite:** iFlow CLI must be installed and accessible (`iflow --help`).

---

## Build & Dev Commands

| Command | Description |
|---------|-------------|
| `npm run tauri:dev` | Full app dev (runs `npm run clean` then `tauri dev`) |
| `npm run dev` | Frontend-only dev server on port 1420 |
| `npm run build` | `tsc && vite build` |
| `npm run tauri:build` | Production desktop build |
| `npm test` | Run Vitest frontend tests |
| `cd src-tauri && cargo check` | Type-check Rust backend |
| `cd src-tauri && cargo build` | Build Rust backend |
| `cd src-tauri && cargo test` | Run Rust tests |
| `npm run clean` | Kill orphan iFlow/Tauri processes (runs `scripts/clean-dev.js`) |

**Run a single Rust test:**
```bash
cd src-tauri && cargo test <test_name>
```

**Run a single Vitest test:**
```bash
npx vitest run src/features/agents/model.test.ts
```

---

## Architecture

### Frontend (src/)

No UI framework — direct DOM manipulation via element references from `dom.ts`. All state lives in a single mutable object (`store.ts`) with no reactivity system; UI updates are triggered explicitly after state mutations.

```
src/
├── main.ts                 # Bootstrap: load agents, wire events, start periodic save
├── store.ts                # Central state object + accessor functions
├── types.ts                # All TypeScript interfaces and type aliases
├── config.ts               # Timeout constants
├── dom.ts                  # DOM element references (getElementById wrappers)
├── features/
│   ├── app.ts              # Main app logic: event wiring, send/receive, UI orchestration (~68KB)
│   ├── agents/             # Agent CRUD, model switching, reconnect, tool calls, git, registry
│   ├── sessions/index.ts   # Session management, history import, title generation
│   ├── storage/index.ts    # Persistence: serialize/deserialize snapshots via Tauri commands
│   ├── ui/index.ts         # Rendering: messages, markdown, artifact preview, slash menu
│   ├── capabilities/       # MCP server & skill enable/disable toggles
│   ├── contextUsage.ts     # Token estimation & context window progress bar
│   ├── messageWatchdog.ts  # Send timeout detection
│   └── historyContinuation.ts  # History continuation toggle
├── services/
│   ├── tauri.ts            # Typed wrappers for all Tauri invoke calls
│   └── events.ts           # Typed Tauri event listeners (stream-message, tool-call, etc.)
├── lib/
│   ├── markdown.ts         # Markdown→HTML rendering
│   ├── tokens.ts           # Token counting heuristics
│   ├── modelContext.ts     # Model→context-window mapping
│   ├── contextCompression.ts  # Context compression estimation
│   ├── html.ts             # HTML escaping
│   └── utils.ts            # Shared utilities
└── test/setup.ts           # Vitest setup: localStorage mock
```

### Backend (src-tauri/src/)

```
src-tauri/src/
├── main.rs                 # Tauri builder: registers all commands, handles app shutdown
├── state.rs                # AppState (holds AgentManager + storage lock)
├── manager.rs              # AgentManager: RwLock<HashMap> of agent instances
├── models.rs               # Shared data types: AgentInfo, ListenerCommand, ConnectResponse
├── commands.rs             # All #[tauri::command] handlers
├── agents/
│   ├── iflow_adapter.rs    # ACP WebSocket client: connect, RPC, message listener loop
│   ├── session_params.rs   # ACP RPC parameter builders (initialize, session/new, prompt)
│   └── mod.rs
├── router.rs               # ACP message router: dispatches sessionUpdate subtypes to Tauri events
├── history.rs              # iFlow JSONL history file reader (session-*.jsonl)
├── storage.rs              # App data dir JSON snapshot persistence
├── model_resolver.rs       # `iflow --list-models` invocation and output parsing
├── git.rs                  # `git status` and `git diff` for workspace file changes
├── artifact.rs             # HTML artifact path resolution and file reading
├── runtime_env.rs          # PATH resolution for iFlow executable
└── dialog.rs               # Native folder picker (rfd)
```

### Key Data Flow

1. **Connecting:** Frontend calls `connectIflow()` → Rust spawns `iflow --experimental-acp --port <N>` → opens WebSocket to `ws://127.0.0.1:<N>/acp` → runs ACP `initialize` + `session/new` → stores `AgentInstance` with `MessageSender` channel
2. **Messaging:** Frontend calls `sendMessage()` → Rust sends `ListenerCommand::UserPrompt` through mpsc channel → ACP listener task sends JSON-RPC `session/prompt` → chunks arrive as `sessionUpdate` → `router.rs` dispatches to Tauri events (`stream-message`, `tool-call`, `task-finish`)
3. **Streaming:** Frontend listens to Tauri events via `services/events.ts` → `features/app.ts` handlers update `state` and call render functions
4. **Persistence:** Every 30s + on `beforeunload`, frontend builds a `StorageSnapshot` (sessions + messages) and saves via Tauri command to `iflow-session-store-{env}.json` in app data dir

### ACP Protocol

The iFlow agent communicates via JSON-RPC 2.0 over WebSocket. Key RPC methods:
- `initialize` — handshake with agent capabilities
- `session/new` — create a new conversation session
- `session/load` — resume an existing session
- `session/prompt` — send user message (triggers streaming response)
- `session/cancel` — abort current generation
- `about` — query agent metadata (model, capabilities)
- `commands/list` — list available slash commands
- `models/list` — list available models

Session update types dispatched by `router.rs`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `user_message_chunk`.

### Tauri Event Names

| Event | Direction | Payload |
|-------|-----------|---------|
| `stream-message` | Rust → TS | `{ agentId, content, type }` where type is `content\|thought\|system\|plan` |
| `tool-call` | Rust → TS | `{ agentId, toolCalls: ToolCall[] }` |
| `task-finish` | Rust → TS | `{ agentId, reason }` |
| `command-registry` | Rust → TS | `{ agentId, commands, mcpServers }` |
| `model-registry` | Rust → TS | `{ agentId, models, currentModel }` |
| `acp-session` | Rust → TS | `{ agentId, sessionId }` |
| `agent-error` | Rust → TS | `{ agentId, error }` |

---

## Code Conventions

### Frontend

- **No framework:** All UI is direct DOM manipulation. Element references come from `dom.ts` (`getElementById` wrappers with `El` suffix). Render functions read from `state` and write to DOM.
- **State pattern:** `store.ts` exports a single mutable `state` object. Mutations are in-place; there is no reactivity. After mutating state, explicitly call render/update functions.
- **Tauri calls go through `services/tauri.ts`:** Never call `invoke()` directly outside this file. All Tauri commands have typed wrappers there.
- **Event listeners go through `services/events.ts`:** Typed wrappers for `listen()` calls.
- **Agent data keyed by agentId:** Sessions in `state.sessionsByAgent`, messages in `state.messagesBySession`, tool calls in `state.toolCallsByAgent`, etc.
- **Naming:** camelCase for variables/functions, PascalCase for interfaces/types, SCREAMING_SNAKE_CASE for constants.

### Backend

- **Tauri commands** return `Result<T, String>` and are defined in `commands.rs` (except `storage.rs` and `history.rs` which define their own).
- **Agent instances** are managed through `AgentManager` (RwLock-wrapped HashMap). Access via `sender_of()`, `upsert()`, `remove()`, `port_of()`.
- **Message passing:** Each agent has an `mpsc::UnboundedSender<ListenerCommand>` for sending commands to the background WebSocket listener task.
- **Model switching** tries ACP `models/set` first; falls back to killing and respawning the agent process.
- **Storage lock:** `AppState.storage_lock` (Mutex) prevents concurrent file access during snapshot save/load.
- **Process cleanup:** On app exit, `shutdown_all_agents` terminates all child processes (SIGTERM then SIGKILL on Unix).
- **Naming:** snake_case for functions/variables, PascalCase for structs/enums. Tauri command params use camelCase (auto-converted from snake_case Rust args).

### Frontend Tests

- Vitest with jsdom environment. Setup in `src/test/setup.ts` mocks `localStorage`.
- Test files colocated with source: `*.test.ts` alongside the module they test.
- No frontend lint command configured. TypeScript strict mode is enabled (`noUnusedLocals`, `noUnusedParameters`).

### Rust Tests

- Inline `#[cfg(test)]` modules in the same `.rs` file.
- Async tests use `#[tokio::test]`.
- Some tests create temp directories; clean up after themselves.
