# AgenticAGI UI — Current State

## Overview

Single-file web application backed by a custom WebSocket server. No frontend framework — vanilla JS, native DOM. Server is Node.js with a hand-rolled RFC 6455 WebSocket implementation (no `ws` package).

**Access**: `http://127.0.0.1:3009` (configurable via `UI_START_PORT`)

---

## File Map

| File | Role |
|------|------|
| `public/index.html` | Entire client: HTML + embedded CSS + JS (~3,241 lines) |
| `server/ui-server.ts` | WebSocket server, agent integration, provider/model/memory management |
| `server/ui-bootstrap.mjs` | Boot script: transpiles TS → ES2022, copies assets, launches server |
| `scripts/ui-app-launcher.mjs` | Detached process controller with health-check and browser open |
| `scripts/build-macos-launcher.mjs` | Builds `.app` bundles (Launcher + Stop) for macOS |
| `.ui-control/ui-server-state.json` | Runtime PID/port/URL state file |
| `.ui-runtime/` | Build output (transpiled core/ + config/ + server/ + public copy) |

---

## Starting the UI

```bash
# Foreground (blocks terminal, logs to stdout)
pnpm run ui

# Detached (launcher manages PID)
pnpm run ui:start

# Detached + open browser
pnpm run ui:open

# Check running state
pnpm run ui:status

# Graceful shutdown
pnpm run ui:stop
```

---

## Layout

3-column grid on desktop, collapses progressively on smaller viewports.

```
┌─────────────────────────────────────────────────────────┐
│  Header: brand | provider toggle | model selector        │
│          theme | settings | logs                         │
├─────────────────────┬───────────────┬────────────────────┤
│                     │               │                    │
│   Chat messages     │  Plan panel   │   Logs panel       │
│                     │  (live tree)  │   (transparency)   │
│   ─────────────     │               │                    │
│   Composer textarea │               │                    │
└─────────────────────┴───────────────┴────────────────────┘
```

| Breakpoint | Layout |
|------------|--------|
| ≥1180px | 3 columns |
| 980–1180px | 2 columns (chat + compact plan/logs) |
| <980px | Single column, plan/logs as overlay |

---

## Client State

```javascript
state = {
  connected: boolean,
  socket: WebSocket | null,
  processing: boolean,
  providerMode: 'local' | 'cloud',
  reconnectDelay: number,       // 3000ms → 30000ms backoff
  reconnectTimer: number | null,
  messages: Message[],
  selectedLocalModel: string,
  selectedCloudModel: string,
}
```

Persisted to `localStorage`: `localModel`, `cloudModel`, `theme`.

---

## WebSocket Protocol

### Client → Server

| Message | Payload |
|---------|---------|
| `chat` | `{ text: string }` |
| `set_provider_mode` | `{ mode: 'local' \| 'cloud' }` |
| `set_local_model` | `{ model: string }` |
| `set_cloud_model` | `{ model: CloudModelId }` |
| `set_memory_mode` | `{ mode: 'enabled' \| 'disabled' }` |
| `refresh_models` | — |
| `ping` | — |

### Server → Client

| Message | Payload |
|---------|---------|
| `agent_reply` | `{ text: string; intent?: string }` |
| `transparency` | `{ event: string; payload: unknown; ts: number }` |
| `plan_update` | `{ plan: PlanSnapshot }` |
| `step_update` | `{ stepId, status, elapsed? }` |
| `milestone_update` | `{ milestoneId, status }` |
| `provider_status` | `{ provider: ProviderStatus }` |
| `memory_mode_status` | `{ mode: 'enabled' \| 'disabled' }` |
| `error` | `{ message: string }` |
| `pong` / `models_refreshed` | — |

---

## UI Panels

### Chat Panel
- Message bubbles: user / agent / error styles
- Typing indicator (animated 3-dot)
- Auto-expanding textarea (46–180px)
- Starter suggestion buttons (benchmark tasks, normal chat)
- Connection status dot (green/red)

### Provider & Model Header
- **Local / Cloud** radio toggle
- Model dropdown with tag chips: `balanced` `fast` `tiny` `vision` `mlx` `alt`
- 30+ pre-configured models in `MODEL_CATALOG`
- Local provider: LM Studio endpoint
- Cloud providers: Anthropic API, Google Gemini API

### Plan Panel
- Live goal + complexity label
- Milestone tree → step list
- Node statuses: `pending` → `running` → `done` / `failed`
- Elapsed time per step
- QueryLoop synthetic diagram for LOW/MEDIUM complexity tasks

### Logs Panel
- All agent transparency events streamed in real time
- Filter tabs: All / Errors / Success / Iterations (with badge counts)
- Per-event: **Copy trace** (formatted) | **Copy details** (raw JSON)
- Ring buffer: 2000 events in `window.__fullEnvelopes`

### Settings Panel
- Memory enable/disable toggle (broadcasts to all connected clients)
- Light / Dark theme switcher (persisted to localStorage)
- Slide-in animation (CSS transform)

---

## Server Architecture

### Bootstrap Flow (`ui-bootstrap.mjs`)
1. Delete `.ui-runtime/`
2. Transpile `core/`, `config/`, `server/` (TS → ES2022 via `ts.transpileModule`)
3. Copy `public/` to `.ui-runtime/public/`
4. Dynamic `import('ui-server.js?ts=<timestamp>')` to bust module cache

### Key Server Functions

| Function | What it does |
|----------|-------------|
| `handleChat()` | Runs `processMessage()`, streams transparency events back |
| `handleClientMessage()` | Routes all incoming WS message types |
| `handleTransparencyEvent()` | Converts agent events → `plan_update` / `step_update` / `transparency` |
| `getProviderRuntime()` | Resolves primary + fallback LLM profiles |
| `getProviderStatus()` | Returns current mode, selected models, availability |

### Custom WebSocket Implementation
- Manual RFC 6455 frame parser (`readFrame()`)
- Payload masking/unmasking (client → server direction)
- Large-frame assembly for payloads >65KB
- SHA1 handshake with `ACCEPT_GUID`

---

## macOS App Bundles

Built via `scripts/build-macos-launcher.mjs`:

- **AgenticAGI Launcher.app** — starts detached server + opens browser
- **Stop AgenticAGI.app** — graceful shutdown

Bundles contain `Info.plist` + shell wrapper scripts. Output path: `apps/macos/build/`.

---

## Known Constraints

- No HMR or hot reload — restart required after `ui-server.ts` changes
- `public/index.html` is a monolith; splitting it requires a build step that doesn't currently exist
- Model catalog (`MODEL_CATALOG`) is hardcoded client-side; new models require editing `index.html`
- WebSocket server is single-process; no clustering or graceful connection migration on restart
