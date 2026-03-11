#!/usr/bin/env tsx
/**
 * CLINC150 Intent Classifier Evaluator
 * Usage: pnpm tsx scripts/eval_intent.ts [sample_size] [seed]
 * Example: pnpm tsx scripts/eval_intent.ts 150 42
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyIntent } from '../core/intent.ts';

const SAMPLE_SIZE = parseInt(process.argv[2] ?? '150', 10);
const SEED = parseInt(process.argv[3] ?? String(Date.now()), 10);

type ClincItem = { text: string; intent: string };
type ZarabanIntent =
  | 'memory_write'
  | 'memory_read'
  | 'memory_update'
  | 'memory_delete'
  | 'planned_workflow'
  | 'episodic_query'
  | 'meeting'
  | 'general';

const UPDATE_TEXT_PATTERN =
  /\b(update|change|modify|edit|rename|correct|set\s+\w+\s+to|switch|replace)\b/i;
const DELETE_TEXT_PATTERN =
  /\b(delete|remove|erase|forget|clear\s+all|wipe)\b/i;

function mapClassifierToZarabanBucket(
  text: string,
  intent: string,
): ZarabanIntent {
  const msg = text.trim();

  if (intent === 'meeting') return 'meeting';
  if (intent === 'episodic_query') return 'episodic_query';

  if (intent === 'memory_query' || intent === 'code_fetch' || intent === 'relationship_query') {
    return 'memory_read';
  }

  if (intent === 'memory_write') {
    if (DELETE_TEXT_PATTERN.test(msg)) return 'memory_delete';
    if (UPDATE_TEXT_PATTERN.test(msg)) return 'memory_update';
    return 'memory_write';
  }

  if (
    intent === 'planned_workflow' ||
    intent === 'skill' ||
    intent === 'web_search' ||
    intent === 'relationship_write' ||
    intent === 'synthesis_query'
  ) {
    return 'planned_workflow';
  }

  return 'general';
}

// Seeded shuffle (deterministic per seed)
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

const raw = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data/clinc/clinc150_full.json'), 'utf8'),
) as ClincItem[];

const mapping = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data/clinc/clinc150_mapping.json'), 'utf8'),
) as Record<string, ZarabanIntent>;

const uniqueIntents = [...new Set(raw.map(r => r.intent))].sort();
const missingMappings = uniqueIntents.filter(intent => !mapping[intent]);
if (missingMappings.length > 0) {
  console.error('Missing CLINC150 mappings for intents:');
  for (const intent of missingMappings) {
    console.error(`- ${intent}`);
  }
  process.exit(2);
}

const rng = seededRandom(SEED);
const shuffled = [...raw].sort(() => rng() - 0.5);
const sample = shuffled.slice(0, SAMPLE_SIZE);

let correct = 0;
let wrong = 0;
const failures: Array<{
  text: string;
  clinc_intent: string;
  expected_zaraban: ZarabanIntent;
  got_zaraban: ZarabanIntent;
  got_classifier_intent: string;
}> = [];

for (const item of sample) {
  const expectedZaraban = mapping[item.intent];
  if (!expectedZaraban) continue;

  const result = classifyIntent(item.text);
  const gotZaraban = mapClassifierToZarabanBucket(item.text, result.intent);

  if (gotZaraban === expectedZaraban) {
    correct++;
  } else {
    wrong++;
    failures.push({
      text: item.text,
      clinc_intent: item.intent,
      expected_zaraban: expectedZaraban,
      got_zaraban: gotZaraban,
      got_classifier_intent: result.intent,
    });
  }
}

const accuracy = ((correct / SAMPLE_SIZE) * 100).toFixed(1);

console.log('\n========================================');
console.log(`SEED: ${SEED}  SAMPLE: ${SAMPLE_SIZE}`);
console.log(`ACCURACY: ${accuracy}%  (${correct}/${SAMPLE_SIZE})`);
console.log('========================================\n');

if (failures.length > 0) {
  console.log(`\n--- FAILURES (${failures.length}) ---\n`);

  const groups: Record<string, typeof failures> = {};
  for (const f of failures) {
    const key = `${f.expected_zaraban} → ${f.got_zaraban}`;
    groups[key] = groups[key] ?? [];
    groups[key].push(f);
  }

  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  for (const [pattern, items] of sorted) {
    console.log(`\n[${items.length}x] EXPECTED ${pattern}`);
    for (const item of items.slice(0, 5)) {
      console.log(`  CLINC: ${item.clinc_intent}`);
      console.log(`  INTENT: ${item.got_classifier_intent}`);
      console.log(`  TEXT:  "${item.text}"`);
    }
    if (items.length > 5) console.log(`  ... and ${items.length - 5} more`);
  }
}

process.exit(failures.length === 0 ? 0 : 1);
