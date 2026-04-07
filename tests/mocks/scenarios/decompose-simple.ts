/**
 * Simple decomposition scenario
 * Single user message → one agentic unit
 */
import type { MockScenario } from '../MockLLMHandler.js';

export const decomposeSimple: MockScenario[] = [
  {
    trigger: 'Decompose the following',
    response: JSON.stringify({
      units: [
        { route: 'agentic', content: 'write hello world to hello.txt' },
      ],
    }),
  },
];
