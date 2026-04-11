import { transparency } from './transparency.js';

// Session-only counters — module-level, no persistence, no SQLite
let inputTokens = 0;
let outputTokens = 0;
let callCount = 0;

// Flat Sonnet-tier rates (adjust if using different models)
const INPUT_COST_PER_TOKEN = 0.000003;   // $3 / 1M tokens
const OUTPUT_COST_PER_TOKEN = 0.000015;  // $15 / 1M tokens

export function recordTokens(input: number, output: number): void {
  inputTokens += input;
  outputTokens += output;
  callCount += 1;

  transparency.emit({
    type: 'token_usage',
    data: {
      inputTokens,
      outputTokens,
      callCount,
      estimatedCostUSD: inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN,
    },
  });
}

export function getTokenStats(): {
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  estimatedCostUSD: number;
} {
  return {
    inputTokens,
    outputTokens,
    callCount,
    estimatedCostUSD: inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN,
  };
}

export function resetTokenStats(): void {
  inputTokens = 0;
  outputTokens = 0;
  callCount = 0;
}
