# AGENTS.md - iFlow Workspace

## Project Overview

Multi-Agent Desktop App built with Tauri 2.0 (Rust backend + TypeScript frontend).

**Tech Stack:**
- Frontend: TypeScript + Vite
- Backend: Rust + Tauri 2.0
- Build: Tauri CLI

---

## Build Commands

### Frontend (TypeScript/Vite)

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (port 1420) |
| `npm run build` | Build frontend for production |
| `npm run preview` | Preview production build |

### Tauri (Full App)

| Command | Description |
|---------|-------------|
| `npm run tauri:dev` | Run app in development mode |
| `npm run tauri:build` | Build production release |
| `npm run tauri` | Run Tauri CLI directly |

### Rust Commands

| Command | Description |
|---------|-------------|
| `cd src-tauri && cargo build` | Build Rust backend |
| `cd src-tauri && cargo run` | Run Rust backend directly |
| `cd src-tauri && cargo check` | Type-check Rust code |
| `cd src-tauri && cargo test` | Run Rust tests |

### Running a Single Test

**Rust:**
```bash
cd src-tauri && cargo test <test_name>
# Example: cargo test connect_iflow
```

---

## Code Style Guidelines

### TypeScript

**General:**
- Use strict TypeScript (`strict: true` in tsconfig.json)
- Always type function parameters and return values
- Use `interface` for object shapes, `type` for unions/aliases

**Naming:**
- Variables/functions: camelCase (`agentList`, `sendMessage`)
- Interfaces/Types: PascalCase (`Agent`, `Message`)
- Constants: SCREAMING_SNAKE_CASE
- DOM elements: suffix with `El` (`addAgentBtnEl`, `messageInputEl`)

**Imports:**
- Use absolute imports from `@tauri-apps/api`
- Group imports: external → internal → types

```typescript
// External
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Types
interface Agent { ... }

// Code
```

**Type Annotations:**
```typescript
// Good
const agentList: Agent[] = [];
function selectAgent(agentId: string): void
const status: 'connected' | 'disconnected' = 'connected';

// Avoid
const agents = [];  // No type
function getAgent(id) { ... }  // No return type
```

**Error Handling:**
- Always use try/catch for async operations
- Log errors with `console.error`
- Show user-friendly error messages

```typescript
try {
  const result = await invoke<ConnectResponse>('connect_iflow', {...});
} catch (error) {
  console.error('Connection error:', error);
  showError(`连接错误: ${error}`);
}
```

---

### Rust

**General:**
- Use Rust 2021 edition
- Enable all lints (`#![deny(warnings)]` in development)
- Use `anyhow` for application errors, `thiserror` for library errors

**Naming:**
- Variables/functions: snake_case (`agent_info`, `connect_iflow`)
- Structs/Enums: PascalCase (`AgentInfo`, `AgentStatus`)
- Modules: snake_case

**Error Handling:**
- Use `Result<T, String>` for simple cases
- Propagate errors with `?` operator
- Provide context in error messages

```rust
// Good
let port = find_available_port()
    .await
    .map_err(|e| format!("Failed to bind: {}", e))?;

// Bad
let port = find_available_port().await.unwrap();
```

**Async:**
- Use `tokio` for async runtime
- Prefer `async/await` over `.and_then()` chains
- Use appropriate tokio features in Cargo.toml

**Visibility:**
- Use `pub` only for items that need to be public
- Keep internal implementation details private

---

### HTML/CSS

**HTML:**
- Use semantic HTML elements
- Add `data-*` attributes for JavaScript hooks
- Use `id` for unique elements, `class` for repeated patterns

**CSS:**
- Keep styles in `src/styles.css`
- Use utility classes where possible
- Prefer flexbox/grid over floats

---

## Project Structure

```
iflow-workspace/
├── src/                    # Frontend TypeScript
│   ├── main.ts            # Main entry point
│   └── styles.css         # Styles
├── src-tauri/             # Rust backend
│   ├── src/
│   │   └── main.rs       # Tauri commands & logic
│   ├── Cargo.toml        # Rust dependencies
│   └── tauri.conf.json   # Tauri config
├── package.json          # NPM config
├── vite.config.ts        # Vite config
└── tsconfig.json         # TypeScript config
```

---

## Common Patterns

### Tauri Commands

Frontend invokes Rust commands via `invoke`:

```typescript
const result = await invoke<ConnectResponse>('connect_iflow', {
  agentId,
  iflowPath,
  workspacePath,
});
```

Rust defines commands with `#[tauri::command]`:

```rust
#[tauri::command]
async fn connect_iflow(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
) -> Result<ConnectResponse, String> { ... }
```

### Event Communication

Frontend listens to events:

```typescript
listen('stream-message', (event) => {
  const payload = event.payload as any;
  // handle
});
```

Rust emits events:

```rust
let _ = app_handle.emit("stream-message", serde_json::json!({
    "agentId": agent_id,
    "content": content,
}));
```

---

## Development Tips

1. **Frontend-only dev:** Run `npm run dev` to test UI
2. **Full app dev:** Run `npm run tauri:dev`
3. **Backend debugging:** Check console output in terminal running `tauri:dev`
4. **WebSocket testing:** Connect to `ws://127.0.0.1:<port>/acp`

---

## Testing

Currently no frontend tests. To add tests:
- Use Vitest for TypeScript unit tests
- Add test scripts to package.json

Rust tests can be added with `#[cfg(test)]` module in `.rs` files.
