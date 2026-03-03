#!/usr/bin/env tsx
/**
 * Test embedding configuration
 * Usage: pnpm tsx scripts/test-embeddings.ts
 */

import { EMBEDDING_CONFIG } from '../config/agent.config.js';
import { fetchEmbeddings } from '../core/memory/embeddings.js';

async function testEmbeddings() {
  console.log('=== Embedding Configuration Test ===\n');

  if (!EMBEDDING_CONFIG) {
    console.log('❌ EMBEDDING_CONFIG is null');
    console.log('→ Embeddings are DISABLED (BM25-only search will be used)');
    console.log('→ To enable, set EMBEDDING_ENDPOINT in .env\n');
    return;
  }

  console.log('✅ EMBEDDING_CONFIG found:');
  console.log(`  Endpoint: ${EMBEDDING_CONFIG.endpoint}`);
  console.log(`  Model: ${EMBEDDING_CONFIG.model}`);
  console.log(`  Dimensions: ${EMBEDDING_CONFIG.dimensions}\n`);

  console.log('Testing embedding generation...');
  try {
    const start = performance.now();
    const embeddings = await fetchEmbeddings(
      ['Hello world', 'Test embedding'],
      EMBEDDING_CONFIG
    );
    const elapsed = Math.round(performance.now() - start);

    console.log(`✅ Success! Generated ${embeddings.length} embeddings in ${elapsed}ms`);
    console.log(`  Dimensions: ${embeddings[0].length}`);
    console.log(`  First 5 values: [${Array.from(embeddings[0].slice(0, 5)).map(v => v.toFixed(4)).join(', ')}...]\n`);
  } catch (err) {
    console.error('❌ Failed to generate embeddings:');
    console.error(`  ${String(err)}\n`);
    console.log('Troubleshooting:');
    console.log('  1. Check API key is set (JINA_API_KEY, OPENAI_API_KEY, etc.)');
    console.log('  2. Check endpoint URL is correct');
    console.log('  3. Check model name matches provider docs');
    console.log('  4. Try: curl -X POST <endpoint> -H "Authorization: Bearer <key>"\n');
  }
}

testEmbeddings().catch(console.error);
