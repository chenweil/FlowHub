# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FlowHub (iflow-workspace) is a Multi-Agent Desktop App built with Tauri 2.0. It provides a workspace for managing iFlow agents with ACP (Agent Communication Protocol) integration, session management, and Git change visualization.

**Tech Stack:**
- Frontend: TypeScript + Vite + vanilla DOM
- Desktop: Tauri 2.0
- Backend: Rust + Tokio + tokio-tungstenite (WebSocket)

**Prerequisite:** iFlow CLI must be installed (`iflow --help` should work).

---

## Commands

### Development

| Command | Description |
|---------|-------------|
| `npm run tauri:dev` | Run full app in development mode (recommended) |
| `npm run dev` | Start Vite dev server only (port 1420) |

### Build & Test

| Command | Description |
|---------|-------------|
| `npm run build` | Build frontend for production |
| `npm run tauri:build` | Build production release |
| `npm test` | Run Vitest unit tests |
| `cd src-tauri && cargo check` | Type-check Rust backend |
| `cd src-tauri && cargo test` | Run Rust tests |
| `cd src-tauri && cargo test <test_name>` | Run single Rust test |

### Clean

| Command | Description |
|---------|-------------|
| `npm run clean` | Clean dev artifacts |
| `npm run kill` | Alias for clean |

---

## Architecture

### Frontend-Backend Communication

```
Frontend (TS)                    Backend (Rust)
     │                                │
     │  invoke('connect_iflow')       │
     │ ──────────────────────────────>│
     │                                │  spawn iFlow process
     │                                │  WebSocket connect to ws://127.0.0.1:{port}/acp
     │                                │
     │  listen('stream-message')      │
     │ <──────────────────────────────│
     │  listen('tool-call')           │
     │ <──────────────────────────────│
     │  listen('task-finish')         │
     │ <──────────────────────────────│
```

**Tauri Commands** (defined in `src-tauri/src/commands.rs`):
- `connect_iflow` - Spawn iFlow process with ACP, establish WebSocket connection
- `send_message` - Send user prompt via ACP
- `stop_message` - Cancel current generation
- `switch_agent_model` - Switch model (restarts ACP session)
- `toggle_agent_think` - Enable/disable extended thinking
- `disconnect_agent` - Terminate iFlow process
- `list_available_models` - Query available models from iFlow
- `discover_skills` - Scan `~/.iflow/skills/` for SKILL.md files

**Events** (emitted from Rust, listened in `src/services/events.ts`):
- `stream-message` - Text content chunks (content/thought/system/plan types)
- `tool-call` - Tool execution status updates
- `task-finish` - Generation complete signal
- `agent-error` - Error notifications

### State Management

Frontend uses a centralized state object (`src/store.ts`):
```typescript
state = {
  agents: Agent[],           // Agent list
  currentAgentId: string,    // Active agent
  sessionsByAgent: {},       // Session mapping
  messagesBySession: {},     // Message mapping
  toolCallsByAgent: {},      // Tool call tracking
  // ... UI states
}
```

Backend uses `AgentManager` (`src-tauri/src/manager.rs`) with async RwLock for concurrent access.

### Key Modules

**Frontend (`src/`):**
- `main.ts` - App initialization, event listener setup
- `store.ts` - Central state object
- `types.ts` - TypeScript interfaces
- `services/tauri.ts` - Typed wrappers for `invoke` calls
- `services/events.ts` - Typed event listeners
- `features/agents/` - Agent management (add, select, delete, reconnect, model switching)
- `features/sessions/` - Session management
- `features/storage/` - Persistence layer
- `lib/tokens.ts` - Token estimation utilities

**Backend (`src-tauri/src/`):**
- `main.rs` - Tauri app setup, command registration
- `commands.rs` - Tauri command implementations
- `agents/iflow_adapter.rs` - WebSocket listener, ACP protocol handling
- `agents/session_params.rs` - ACP session parameter builders
- `router.rs` - Event routing from ACP messages to frontend
- `manager.rs` - Agent instance management
- `state.rs` - AppState struct
- `models.rs` - Rust data structures
- `history.rs` - iFlow history file parsing
- `git.rs` - Git change detection

---

## Patterns

### Adding a new Tauri command

1. Define in `src-tauri/src/commands.rs`:
```rust
#[tauri::command]
pub async fn my_command(state: State<'_, AppState>, arg: String) -> Result<MyResult, String> {
    // implementation
}
```

2. Register in `src-tauri/src/main.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    my_command,
    // ...other commands
])
```

3. Create typed wrapper in `src/services/tauri.ts`:
```typescript
export function myCommand(arg: string): Promise<MyResult> {
  return invoke<MyResult>('my_command', { arg });
}
```

### Adding a new event type

1. Emit from Rust:
```rust
let _ = app_handle.emit("my-event", json!({ "key": "value" }));
```

2. Listen in frontend (`src/services/events.ts`):
```typescript
export function onMyEvent(callback: (payload: MyPayload) => void): Promise<UnlistenFn> {
  return listen<MyPayload>('my-event', (event) => callback(event.payload));
}
```

### Code Style

**TypeScript:**
- Use `interface` for object shapes, `type` for unions
- Suffix DOM element variables with `El` (e.g., `inputEl`)
- Always type function parameters and return values
- Use try/catch for async operations

**Rust:**
- Use `Result<T, String>` for Tauri command returns
- Propagate errors with `?` operator
- Use `anyhow` for internal errors

---

## Testing

- Frontend: Vitest (`src/**/*.test.ts`)
- Backend: Rust `#[test]` modules in source files

Run specific test:
```bash
npm test -- --grep "test name"
cd src-tauri && cargo test test_name
```
