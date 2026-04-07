/**
 * Conversational scenarios
 * Return plain text replies (not JSON)
 */
import type { MockScenario } from '../MockLLMHandler.js';

export const conversationalScenarios: MockScenario[] = [
  {
    trigger: 'what is your name',
    response: 'I am Zaraban.',
  },
  {
    trigger: 'hello',
    response: 'Hello! How can I help you today?',
  },
];
