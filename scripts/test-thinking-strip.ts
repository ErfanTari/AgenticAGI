#!/usr/bin/env node
/**
 * Test stripThinkingTags function for proper cleanup
 */

// Replicate the stripThinkingTags function for testing
function stripThinkingTags(raw: string): string {
  let cleaned = raw;

  // Remove complete <think>...</think> blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Remove orphaned closing </think> tags
  cleaned = cleaned.replace(/<\/think>/gi, '');

  // Remove "Let me X" preamble sentences
  cleaned = cleaned.replace(/^Let me [^\n]+\n/gim, '');

  // Remove "I need to X" preamble sentences
  cleaned = cleaned.replace(/^I need to [^\n]+\n/gim, '');

  // Remove "I will X" preamble sentences
  cleaned = cleaned.replace(/^I will [^\n]+\n/gim, '');

  // Remove "I can see X" preamble sentences
  cleaned = cleaned.replace(/^I can see [^\n]+\n/gim, '');

  // Remove "I should X" preamble sentences
  cleaned = cleaned.replace(/^I should [^\n]+\n/gim, '');

  // Remove "Let's X" preamble sentences
  cleaned = cleaned.replace(/^Let['´]s [^\n]+\n/gim, '');

  // Remove Thinking Process: blocks (Qwen format)
  cleaned = cleaned.replace(/Thinking Process:[\s\S]*?(?=\n\n|$)/gi, '');

  // Remove numbered analysis blocks starting with **Analyze
  cleaned = cleaned.replace(/\*\*Analyze[\s\S]*?(?=\n\n[A-Z]|$)/gi, '');

  // Remove <|im_start|>...<|im_end|> tokens
  cleaned = cleaned.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
  cleaned = cleaned.replace(/<\|im_start\|>/g, '');
  cleaned = cleaned.replace(/<\|im_end\|>/g, '');

  return cleaned.trim();
}

interface TestCase {
  name: string;
  input: string;
  shouldNotContain?: string[];
  shouldStartWith?: string;
}

const testCases: TestCase[] = [
  {
    name: '1. Complete <think> block removal',
    input: '<think>Analyzing the query...</think>\nHere is the answer.',
    shouldNotContain: ['<think>', '</think>', 'Analyzing'],
    shouldStartWith: 'Here is',
  },
  {
    name: '2. Orphaned </think> tag',
    input: 'Some response\n</think>\nActual content here',
    shouldNotContain: ['</think>'],
    shouldStartWith: 'Some response',
  },
  {
    name: '3. "Let me" preamble',
    input: 'Let me summarize what was found...\nThe results show:',
    shouldNotContain: ['Let me'],
    shouldStartWith: 'The results',
  },
  {
    name: '4. "I need to" preamble',
    input: 'I need to provide a clear answer.\nHere is what I found:',
    shouldNotContain: ['I need to'],
    shouldStartWith: 'Here is',
  },
  {
    name: '5. "I will" preamble',
    input: 'I will present this in bullet points.\n- Point 1\n- Point 2',
    shouldNotContain: ['I will'],
    shouldStartWith: '-',
  },
  {
    name: '6. Mixed thinking artifacts',
    input:
      '<think>Reasoning...</think>\nLet me analyze this.\nI need to extract data.\n<|im_start|>assistant<|im_end|>\nFinal answer',
    shouldNotContain: ['<think>', '</think>', 'Let me', 'I need', '<|im_start|>', 'Reasoning'],
    shouldStartWith: 'Final answer',
  },
  {
    name: '7. "Thinking Process:" block (Qwen)',
    input:
      'Thinking Process:\nStep 1: Understand\nStep 2: Analyze\n\nThe actual response here',
    shouldNotContain: ['Thinking Process', 'Step 1', 'Step 2'],
    shouldStartWith: 'The actual',
  },
  {
    name: '8. Multiple preamble sentences',
    input:
      'Let me start by understanding the question.\nI should check the facts.\nI can see there are multiple angles.\nHere is my answer:',
    shouldNotContain: ['Let me', 'I should', 'I can see'],
    shouldStartWith: 'Here is my',
  },
  {
    name: '9. Clean response (no artifacts)',
    input: 'This is a clean response with no thinking tags.',
    shouldNotContain: [],
    shouldStartWith: 'This is a',
  },
  {
    name: '10. Edge case: "Let\'s" instead of "Let me"',
    input: "Let's break this down.\nThe answer is clear.",
    shouldNotContain: ["Let's"],
    shouldStartWith: 'The answer',
  },
];

console.log('🧪 Testing stripThinkingTags Function\n');
console.log('=' .repeat(60));

let passed = 0;
let failed = 0;

for (const test of testCases) {
  console.log(`\n${test.name}`);
  console.log('-'.repeat(60));

  const result = stripThinkingTags(test.input);
  let testPassed = true;
  const issues: string[] = [];

  // Check "should not contain"
  if (test.shouldNotContain) {
    for (const forbidden of test.shouldNotContain) {
      if (result.includes(forbidden)) {
        issues.push(`  ❌ Still contains: "${forbidden}"`);
        testPassed = false;
      }
    }
  }

  // Check "should start with"
  if (test.shouldStartWith) {
    if (!result.startsWith(test.shouldStartWith)) {
      issues.push(
        `  ❌ Should start with "${test.shouldStartWith}", got: "${result.substring(0, 40)}..."`
      );
      testPassed = false;
    }
  }

  if (testPassed) {
    console.log('✅ PASS');
    passed++;
  } else {
    console.log('❌ FAIL');
    issues.forEach(i => console.log(i));
    failed++;
  }

  console.log(`\n  Input: ${test.input.substring(0, 50)}${test.input.length > 50 ? '...' : ''}`);
  console.log(`  Output: ${result.substring(0, 50)}${result.length > 50 ? '...' : ''}`);
}

console.log('\n' + '='.repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed === 0) {
  console.log('✨ All tests passed! stripThinkingTags is working correctly.\n');
  process.exit(0);
} else {
  console.log(`⚠️  ${failed} test(s) failed.\n`);
  process.exit(1);
}
