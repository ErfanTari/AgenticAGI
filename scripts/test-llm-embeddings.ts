#!/usr/bin/env node
/**
 * Test LLM-based embeddings using local Qwen model
 */

import { fetchEmbeddings } from '../core/memory/embeddings.js';

const testTexts = [
  'Sara Ahmadi is a software engineer working on AI projects',
  'The portfolio website showcases my best work',
  'Node.js is a JavaScript runtime for building web applications',
];

console.log('🧪 Testing LLM-based Embeddings\n');
console.log('📊 Test Texts:');
testTexts.forEach((text, i) => {
  console.log(`  ${i + 1}. "${text.substring(0, 50)}..."`);
});

console.log('\n⏳ Generating embeddings from local LLM...');
const startTime = Date.now();

try {
  const embeddings = await fetchEmbeddings(testTexts);
  const elapsed = Date.now() - startTime;

  console.log(`\n✅ Success! Generated ${embeddings.length} embeddings in ${elapsed}ms\n`);

  embeddings.forEach((emb, i) => {
    const nonZero = Array.from(emb).filter(v => Math.abs(v) > 0.01).length;
    const avgMag = Math.sqrt(
      Array.from(emb).reduce((sum, v) => sum + v * v, 0) / emb.length
    );
    console.log(`  Embedding ${i + 1}:`);
    console.log(`    Dimensions: ${emb.length}`);
    console.log(`    Non-zero values: ${nonZero} / ${emb.length}`);
    console.log(`    Magnitude: ${avgMag.toFixed(4)}`);
    console.log(`    Sample values: [${Array.from(emb.slice(0, 5)).map(v => v.toFixed(3)).join(', ')}]`);
  });

  console.log('\n✨ Embeddings are ready for vector search!');
} catch (err) {
  console.error('\n❌ Error generating embeddings:');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
