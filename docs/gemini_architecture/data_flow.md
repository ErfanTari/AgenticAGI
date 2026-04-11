# AgenticAGI Data Flow

The flow of data through AgenticAGI follows a structured pipeline from user input to final action and memory update.

## 1. Input Phase
- User interacts via CLI (`chat.ts`) or Web UI (`server/ui-server.ts`).
- Message is sent to `core/agent.ts`.

## 2. Decomposition & Routing
- `core/decomposition.ts` breaks the message into semantic units.
- `core/router.ts` determines the complexity (Simple, Medium, Complex).
- Task is assigned to the appropriate execution engine (`query-loop.ts`, `planner.ts`, or `executor.ts`).

## 3. Augmentation & Context Assembly
- Relevant memory is fetched via the memory resolver pipeline (`core/memory/index.ts`).
- Context is assembled (`core/context.ts`) with memories, constraints, and history.
- The augmented prompt is sent to the LLM.

## 4. Execution & Skills
- The execution engine receives actions from the LLM.
- Actions are validated and executed via the `skills/` registry.
- Transparency events are emitted at every step to the UI server.

## 5. Output & Memory Update
- The final response is delivered back to the user interface.
- Successful actions and new knowledge are written to the Markdown files in `memory/`.
- The SQLite index is updated to reflect the new state.
