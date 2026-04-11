# Memory System Architecture

AgenticAGI uses a dual-layer memory system to balance human readability with machine efficiency.

## 1. Canonical Truth (`memory/`)
Knowledge is stored in Markdown files, organized into 7 thematic "notebooks":
- **WHO**: People, entities, and roles.
- **WHAT**: Concepts, objects, and abstract data.
- **WHEN**: Timelines, events, and historical context.
- **HOW**: Procedures, skills, and logic.
- **WHY**: Motivation, intent, and goals.
- **NOW**: Current focus, immediate status, and active context.
- **PLAN**: Future goals and milestones.

## 2. SQLite Derived Index (`index/memory.sqlite`)
A high-performance map of metadata and relationships:
- **Full-Text Search (FTS5)**: Fast retrieval of relevant memory segments.
- **Relationship Mapping**: Tracks connections between entities and concepts.
- **Bootstrapping**: The SQLite index can be fully rebuilt from the Markdown source.

## 3. Memory Retrieval Pipeline
A 5-step escalation ensures efficient knowledge fetching:
1. **Direct Code Matching**: For exact entity hits.
2. **Filtering**: Refinement based on metadata.
3. **Relationship Crawling**: Moving from one concept to related ones.
4. **Name Matching**: Broad searches for entities.
5. **Hybrid Search**: Combining FTS with ranked retrieval.

## 4. Maintenance (`heartbeat.ts`)
Idle-time processes keep the memory healthy:
- **Project Deadlines**: Monitoring for approaching dates.
- **Stale Memory**: Identifying information that needs archival.
- **Dreaming**: Consolidating multiple memory files into more coherent forms.
