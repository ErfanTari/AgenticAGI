/**
 * Mock LLM Handler for testing
 *
 * Provides deterministic LLM responses based on trigger patterns in user messages.
 * Used for end-to-end pipeline testing without hitting a real LLM endpoint.
 */

export interface MockScenario {
  /** Substring to match in the last user message */
  trigger: string;
  /** Raw string to return as the LLM response */
  response: string;
}

export class MockLLMHandler {
  private scenarios: MockScenario[];
  public calls: { messages: unknown[]; response: string }[] = [];

  constructor(scenarios: MockScenario[]) {
    this.scenarios = scenarios;
  }

  readonly handler = async (
    messages: { role: string; content: string }[],
    _options?: unknown,
  ): Promise<string> => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = lastUser?.content ?? '';

    for (const scenario of this.scenarios) {
      if (content.includes(scenario.trigger)) {
        this.calls.push({ messages, response: scenario.response });
        return scenario.response;
      }
    }

    throw new Error(
      `[MockLLMHandler] No scenario matched.\n` +
      `Last user message: "${content.slice(0, 120)}"\n` +
      `Available triggers: ${this.scenarios.map(s => `"${s.trigger}"`).join(', ')}`,
    );
  };

  /** Reset call history between tests */
  reset(): void {
    this.calls = [];
  }
}
