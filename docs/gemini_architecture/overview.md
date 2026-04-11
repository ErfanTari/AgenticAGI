# AgenticAGI Architecture Overview

AgenticAGI is a sophisticated, local-first AI agent platform built with TypeScript. It features a persistent, multi-layered memory system and a robust task execution pipeline.

## System Goals
- **Local-First Reliability**: Operates primarily using local LLMs (via LM Studio) with cloud fallbacks.
- **Persistent Knowledge**: Maintains a "canonical truth" of knowledge in Markdown files, searchable via an SQLite index.
- **Deep Observability**: Real-time visualization of agent reasoning and tool usage through a WebSocket-based Transparency Panel.
- **Agentic Capability**: High-autonomy task execution using milestone-based planning and execution engines.

## Core Pillars
1. **Core Runtime (`core/`)**: The orchestrator of message lifecycle, decomposition, routing, and task execution.
2. **Memory System (`memory/`, `index/`)**: A dual-layered approach combining human-readable Markdown notebooks with high-performance SQLite querying.
3. **Connectivity (`server/`, `apps/`)**: Exposure of agent capabilities via WebSockets, powering UIs and native application integrations.
4. **Skills & Tools**: A registry of MCP-compatible tools for interacting with the environment (file I/O, bash, search, etc.).
