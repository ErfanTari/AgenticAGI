# Tutorial — Using and Testing the Agent Platform

This guide walks you through setup, interactive use, and testing of the agent platform.

---

## 1. Setup

### Prerequisites

- **Node.js 20+** and **pnpm** installed
- (Optional) A local LLM running via [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/)
- (Optional) An Anthropic API key for the Claude fallback

### Install and build

```bash
cd /Users/erfantari/Claude_Code/Projects/AgenticAGI
pnpm install
pnpm build
```

### Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your endpoints:

```bash
# Local model (LM Studio / Ollama)
LLM_ENDPOINT=http://localhost:1234/v1/chat/completions
LLM_MODEL=qwen2.5-7b

# Fallback (optional — used when local model is down)
LLM_FALLBACK_PROVIDER=anthropic
LLM_FALLBACK_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-...

# Embeddings (optional — enables hybrid vector search)
EMBEDDING_ENDPOINT=http://localhost:1235/v1/embeddings
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
```

You can use the platform **without any LLM** for testing — just pass a mock handler (shown below).

---

## 2. Running the Tests

### Full suite

```bash
pnpm test
```

This runs all 226 tests across 7 phases:

| Phase | File | Tests | What it covers |
|-------|------|------:|----------------|
| 1 | `tests/phase1/memory.test.ts` | 15 | SQLite, code generation, markdown files |
| 2 | `tests/phase2/relationship.test.ts` | 17 | Relationship graph queries |
| 3 | `tests/phase3/agent.test.ts` | 45 | Intent classification, agent loop, context |
| 4 | `tests/phase4/search.test.ts` | 35 | BM25, embeddings, hybrid search |
| 5 | `tests/phase5/heartbeat.test.ts` | 27 | Background checks, notifications |
| 6 | `tests/phase6/skills.test.ts` | 63 | Calculator, file_reader, web_search |
| 7 | `tests/phase7/*.test.ts` | 24 | ReAct retry, Zod schemas, planning |

### Run a single phase

```bash
pnpm exec vitest run tests/phase7/
```

### Watch mode (re-runs on file changes)

```bash
pnpm test:watch
```

---

## 3. Using the Agent Programmatically

There is no CLI entry point yet — you interact with the agent by importing its functions. Create a script or use Node's REPL.

### Quick start script

Create a file called `try.ts` in the project root:

```typescript
import { initDatabase } from './core/memory/mod.js';
import { processMessage } from './core/agent.js';

// Initialize the database (creates tables if needed)
initDatabase();

// Send messages to the agent
async function main() {
  // 1. Greeting — no LLM call, instant response
  const hello = await processMessage('hello', []);
  console.log(hello.reply);
  // → "Hello! How can I help you today?"

  // 2. Create a contact — writes to SQLite + markdown file
  const contact = await processMessage('create a contact named John Smith', []);
  console.log(contact.reply);
  // → "Created WHO.CT-000001 — John Smith (WHO.CT)"
  console.log('Code:', contact.created?.code);
  console.log('File:', contact.created?.path);

  // 3. Create a project with a due date
  const project = await processMessage('create a project named Website Redesign due 2025-04-01', []);
  console.log(project.reply);

  // 4. Query memory
  const query = await processMessage('show active projects', []);
  console.log(query.reply);
  console.log('Found:', query.resolved?.entries.length, 'entries');

  // 5. Use a skill (calculator — no LLM needed)
  const calc = await processMessage('calculate 15 percent of 280', []);
  console.log(calc.reply);
  // → includes "42"
}

main().catch(console.error);
```

Run it:

```bash
npx tsx try.ts
```

> **Note:** Memory write and general queries call the LLM. If no LLM is configured, they will fail gracefully. Greetings, calculator, and file_reader work without any LLM.

---

## 4. Using a Mock LLM (No Server Needed)

You can pass a `llmHandler` option to `processMessage` to avoid needing a real LLM:

```typescript
import { initDatabase } from './core/memory/mod.js';
import { processMessage } from './core/agent.js';
import type { Message } from './core/types.js';

initDatabase();

// Mock LLM that returns structured JSON for writes
const mockLLM = async (messages: Message[]) => {
  const system = messages[0].content;

  // Memory write requests
  if (system.includes('memory writing assistant')) {
    return JSON.stringify({
      nb: 'WHO', type: 'CT', name: 'Jane Doe',
      status: 'active',
      summary: 'Designer at Acme Corp',
      body: '# Jane Doe\n\nDesigner working on brand identity.',
    });
  }

  // Skill output passthrough
  if (system.includes('Skill Output')) {
    return 'Here is the result from the skill.';
  }

  // General queries
  return 'Based on the context provided, here is what I found.';
};

async function main() {
  // This uses the mock — no real LLM needed
  const res = await processMessage(
    'create a contact named Jane Doe',
    [],
    { llmHandler: mockLLM },
  );

  console.log(res.reply);       // "Created WHO.CT-000001 — Jane Doe (WHO.CT)"
  console.log(res.created);     // Full IndexEntry object
  console.log(res.intent);      // "memory_write"
}

main().catch(console.error);
```

---

## 5. Testing the Phase 7 Features

### ReAct retry loop

The retry system is transparent — it wraps `runSkill` and retries on failure:

```typescript
import { runWithRetry, repairSkillInput } from './core/react.js';
import { initDatabase } from './core/memory/mod.js';
import type { Message } from './core/types.js';

initDatabase();

// A handler that "repairs" skill input
const repairLLM = async (messages: Message[]) => {
  return JSON.stringify({ expression: '2 + 2' }); // corrected input
};

const result = await runWithRetry('calculator', { expression: 'bad' }, repairLLM);
console.log(result.success);  // true (after repair)
console.log(result.retries);  // 1 (failed once, repaired, succeeded)
console.log(result.output);   // "2 + 2 = 4"
```

### Structured outputs with Zod

```typescript
import { WriteEntrySchema, writeEntryJsonSchema } from './core/schemas.js';

// Validate LLM output
const result = WriteEntrySchema.safeParse({
  nb: 'WHAT', type: 'PJ', name: 'My Project',
  status: 'active', summary: 'A project', body: 'Details here',
});

console.log(result.success); // true
console.log(result.data);    // typed WriteEntry object

// Get JSON schema (for LM Studio response_format)
console.log(JSON.stringify(writeEntryJsonSchema, null, 2));
```

### Due date extraction

```typescript
import { classifyIntent } from './core/intent.js';

console.log(classifyIntent('create a plan due 2025-06-15').due_date);
// → "2025-06-15"

console.log(classifyIntent('create a plan due tomorrow').due_date);
// → tomorrow's date in ISO format

console.log(classifyIntent('create a plan due by next week').due_date);
// → +7 days in ISO format
```

### Vision alignment check

```typescript
import { initDatabase, createEntry } from './core/memory/mod.js';
import { checkVisionAlignment, runHeartbeat } from './core/heartbeat.js';

initDatabase();

// Create a North Star vision
createEntry({
  nb: 'WHY', type: 'MT', name: 'North Star Vision',
  status: 'active', summary: 'Build the best ceramic analysis platform',
  body: 'Our goal is ceramic excellence.',
});

// Create a plan that doesn't align
createEntry({
  nb: 'PLAN', type: 'PL', name: 'Shoe Marketing Sprint',
  status: 'active', summary: 'Launch shoe campaign on social media',
  body: 'Nothing about ceramics.',
});

const drift = checkVisionAlignment();
console.log(drift?.type);    // "vision_drift"
console.log(drift?.message); // "1 active plan(s) may not align with North Star vision"
```

---

## 6. What Works Without an LLM

These features work completely offline, no LLM server needed:

| Feature | Example |
|---------|---------|
| Greetings | `processMessage('hello', [])` |
| Calculator | `processMessage('calculate 2 + 2', [])` |
| File reader | `processMessage('read the file ./package.json', [])` |
| Intent classification | `classifyIntent('show active projects')` |
| Memory operations | `createEntry(...)`, `fetchByCode(...)`, `queryEntries(...)` |
| Relationships | `addRelationship(...)`, `getRelationshipsFrom(...)` |
| Heartbeat checks | `runHeartbeat()`, `checkVisionAlignment()` |
| Schema validation | `WriteEntrySchema.safeParse(...)` |
| Due date extraction | `classifyIntent('plan due tomorrow')` |

Features that **require** an LLM (or mock handler):

| Feature | Why |
|---------|-----|
| Memory write via natural language | LLM extracts structured fields from free text |
| General queries | LLM generates response from resolved context |
| Skill output formatting | LLM wraps raw skill output in natural language |
| ReAct repair | LLM generates corrected skill input |

---

## 7. Project Layout at a Glance

```
memory/           ← Markdown files organized by notebook (WHO/, WHAT/, etc.)
index/            ← memory.sqlite — the index, relationships, counters
core/
  agent.ts        ← processMessage() — main entry point
  intent.ts       ← classifyIntent() — routes messages
  react.ts        ← runWithRetry() — skill retry with LLM repair
  schemas.ts      ← Zod schemas + JSON schema for structured outputs
  heartbeat.ts    ← background checks (deadlines, vision drift, etc.)
  llm.ts          ← callLLM() — primary + fallback
  memory/         ← SQLite, fetch, write, search, embeddings
  skills/         ← calculator, file_reader, web_search
tests/
  phase1-7/       ← 226 tests covering every layer
```

---

## 8. Common Workflows

**"I want to add a new skill"**
1. Create `core/skills/tools/my_skill.ts` implementing `MCPSkill`
2. Call `registerSkill(mySkill)` at the bottom of the file
3. Import it in `core/skills/registry.ts`
4. Add detection patterns in `core/intent.ts` (optional — for auto-routing)

**"I want to run the heartbeat manually"**

```typescript
import { initDatabase } from './core/memory/mod.js';
import { runHeartbeat } from './core/heartbeat.js';

initDatabase();
const result = await runHeartbeat();
console.log(result.notifications); // Any findings
console.log(result.created);       // WHY.MT entries created
```

**"I want to search memory"**

```typescript
import { initDatabase, queryEntries, hybridSearch } from './core/memory/mod.js';

initDatabase();

// SQLite query (fast, structured)
const contacts = queryEntries({ nb: 'WHO', type: 'CT', status: 'active' });

// Hybrid search (BM25 + vector, for vague queries)
const results = await hybridSearch('ceramic color work', { nb: 'WHAT' });
```
