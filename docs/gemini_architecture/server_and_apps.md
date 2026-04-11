# Server & Application Integration Architecture

AgenticAGI exposes its capabilities through several interfaces, facilitating both human interaction and programmatic integration.

## 1. UI Server (`server/ui-server.ts`)
A Node.js server that acts as the primary interface for the agent's web-based capabilities.
- **WebSocket Protocol**: Real-time communication between the agent core and UIs.
- **Transparency Events**: Streams internal reasoning and state changes for visualization.

## 2. Transparency Panel
A core feature of the AgenticAGI experience, visualizing:
- **Reasoning**: The logical steps the agent is taking.
- **Planning**: Active milestones and future steps.
- **Tool Usage**: Real-time feedback on skills being executed.

## 3. macOS Integration (`apps/macos/`)
- Contains templates and build scripts for a native macOS launcher.
- Enables the agent to be deeply integrated into the desktop environment.

## 4. CLI (`chat.ts`)
The traditional interface for interacting with the agent:
- Supports rich terminal output and direct command execution.
- Integrates with the `Agent` class for full task orchestration.
