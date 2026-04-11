# Core Runtime Architecture

The `core/` directory contains the heart of AgenticAGI, managing the lifecycle of user messages and task execution.

## 1. Orchestration (`agent.ts`)
The `Agent` class is the central orchestrator. It handles:
- Message lifecycle from initial input to final response.
- Fast-path bypasses (e.g., `/log` for simple logging).
- Integration with the decomposition and routing pipelines.

## 2. Message Decomposition (`decomposition.ts`)
User messages are split into 'semantic units'. This allows the agent to process complex, multi-part requests more effectively by routing each unit appropriately.

## 3. Task Routing (`router.ts`)
Routes decomposed units based on complexity and intent:
- **Simple Tasks**: Handled by `query-loop.ts`.
- **Complex Tasks**: Handled by `planner.ts` and `executor.ts`.

## 4. Execution Engines
- **Query Loop (`query-loop.ts`)**: An iterative ReAct-style loop for medium-complexity tasks.
- **Planner & Executor (`planner.ts`, `executor.ts`)**: Milestone-based planning for high-autonomy task execution.

## 5. Skills System
A registry of 15+ MCP-compatible tools:
- **File I/O**: Reading and writing files in the workspace.
- **System Access**: Bash command execution (with safety permissions).
- **External Search**: Web search capabilities.
- **Memory Access**: Querying and updating the agent's memory.

## 6. Context Assembly (`context.ts`)
Dynamically constructs the LLM prompt by:
- Ranking memory entries (using LightRAG ranking).
- Including active project constraints and conversation history.
- Managing token budgets to ensure optimal LLM performance.
