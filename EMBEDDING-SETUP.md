# Embedding Provider Setup Guide

The agent uses embeddings for semantic search in Phase 4 (hybrid search). If you don't have LM Studio running locally, you can use a hosted embedding API instead.

---

## ⚡ Quick Start (Jina AI - Free)

**Why Jina?** Free 1M tokens/month, fast, no local model needed.

### 1. Get API Key
Visit https://jina.ai/embeddings and sign up for free.

### 2. Add to `.env`
```env
# Jina AI Embeddings (free tier)
EMBEDDING_ENDPOINT=https://api.jina.ai/v1/embeddings
EMBEDDING_MODEL=jina-embeddings-v3
EMBEDDING_DIMENSIONS=1024
JINA_API_KEY=jina_xxxxxxxxxxxx
```

### 3. Test It
```bash
pnpm build
pnpm tsx scripts/test-embeddings.ts
```

You should see:
```
✅ Success! Generated 2 embeddings in 150ms
  Dimensions: 1024
```

---

## 🌐 All Supported Providers

### 1. Jina AI (Free Tier) ⭐
```env
EMBEDDING_ENDPOINT=https://api.jina.ai/v1/embeddings
EMBEDDING_MODEL=jina-embeddings-v3
EMBEDDING_DIMENSIONS=1024
JINA_API_KEY=jina_xxxxxxxxxxxx
```
- **Free tier:** 1M tokens/month
- **Speed:** ~150ms per request
- **Quality:** Good for general use
- **Signup:** https://jina.ai/embeddings

---

### 2. OpenAI (Paid)
```env
EMBEDDING_ENDPOINT=https://api.openai.com/v1/embeddings
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
OPENAI_API_KEY=sk-xxxxxxxxxxxx
```
- **Pricing:** $0.02 per 1M tokens
- **Speed:** ~100ms per request
- **Quality:** Excellent
- **Signup:** https://platform.openai.com

**Alternative model:**
```env
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIMENSIONS=3072
```
(Higher quality, $0.13 per 1M tokens)

---

### 3. Voyage AI (Paid)
```env
EMBEDDING_ENDPOINT=https://api.voyageai.com/v1/embeddings
EMBEDDING_MODEL=voyage-3-lite
EMBEDDING_DIMENSIONS=512
VOYAGE_API_KEY=pa-xxxxxxxxxxxx
```
- **Pricing:** $0.06 per 1M tokens
- **Speed:** ~120ms per request
- **Quality:** Domain-optimized (code, finance, etc.)
- **Signup:** https://www.voyageai.com

**Alternative models:**
- `voyage-3` (1024 dims) — Better quality, $0.13 per 1M tokens
- `voyage-code-3` (1024 dims) — Optimized for code, $0.12 per 1M tokens

---

### 4. Cohere (Paid)
```env
EMBEDDING_ENDPOINT=https://api.cohere.ai/v1/embed
EMBEDDING_MODEL=embed-english-v3.0
EMBEDDING_DIMENSIONS=1024
COHERE_API_KEY=xxxxxxxxxxxx
```
- **Pricing:** $0.10 per 1M tokens
- **Speed:** ~150ms per request
- **Quality:** Good multilingual support
- **Signup:** https://cohere.ai

**Note:** Cohere uses a slightly different API format. You may need to adjust `fetchEmbeddings()` in `core/memory/embeddings.ts` for the `input_type` parameter.

---

### 5. LM Studio (Local, Free)
```env
EMBEDDING_ENDPOINT=http://localhost:1234/v1/embeddings
EMBEDDING_MODEL=nomic-embed-text-v1.5
EMBEDDING_DIMENSIONS=768
# No API key needed
```
- **Pricing:** Free (local)
- **Speed:** ~50ms per request
- **Quality:** Good for privacy-sensitive use
- **Setup:** Load an embedding model in LM Studio

**Recommended local models:**
- `nomic-ai/nomic-embed-text-v1.5` (768 dims, 0.5GB)
- `BAAI/bge-small-en-v1.5` (384 dims, 0.1GB)

---

## 🔧 Disable Embeddings (BM25 Only)

If you want to skip embeddings entirely, just comment out or remove `EMBEDDING_ENDPOINT` from `.env`:

```env
# EMBEDDING_ENDPOINT=
```

The system will automatically fall back to **BM25-only search** (FTS5 keyword search). This still works well for most queries and is **< 10ms** per search.

**When to disable:**
- Testing Phase 1-3 (before hybrid search)
- Privacy-critical deployments (no external API calls)
- Cost-sensitive setups

---

## 📊 Performance Comparison

| Provider | Speed | Quality | Cost (1M tokens) | Privacy |
|----------|-------|---------|------------------|---------|
| Jina AI | 150ms | Good | **Free** | Low |
| OpenAI | 100ms | Excellent | $0.02 | Low |
| Voyage AI | 120ms | Excellent | $0.06 | Low |
| Cohere | 150ms | Good | $0.10 | Low |
| LM Studio | 50ms | Good | **Free** | **High** |
| BM25 Only | **10ms** | Fair | **Free** | **High** |

**Typical memory index:** 50-100 entries = ~100K tokens embedded once = **< $0.01** with paid providers.

---

## 🧪 Testing Your Setup

### 1. Test embedding generation
```bash
pnpm tsx scripts/test-embeddings.ts
```

Expected output:
```
✅ EMBEDDING_CONFIG found:
  Endpoint: https://api.jina.ai/v1/embeddings
  Model: jina-embeddings-v3
  Dimensions: 1024

Testing embedding generation...
✅ Success! Generated 2 embeddings in 150ms
  Dimensions: 1024
  First 5 values: [0.1234, -0.5678, 0.9012, -0.3456, 0.7890...]
```

### 2. Test semantic search
```bash
pnpm start
```

Then try:
```
> "Remember: I'm working on a neural network project for image classification"
> "find projects about deep learning"
```

If embeddings are working, you should see semantic matches even if keywords don't match exactly.

---

## 🐛 Troubleshooting

### Error: "Embedding API error: 401 Unauthorized"
**Fix:** Check your API key is set correctly in `.env`
```bash
echo $JINA_API_KEY  # Should print your key
```

### Error: "Embedding API error: 404 Not Found"
**Fix:** Check the endpoint URL matches the provider docs
- Jina: `https://api.jina.ai/v1/embeddings`
- OpenAI: `https://api.openai.com/v1/embeddings`
- Voyage: `https://api.voyageai.com/v1/embeddings`

### Error: "Embedding API error: 422 Unprocessable Entity"
**Fix:** Check the model name is correct for your provider
- Jina: `jina-embeddings-v3`
- OpenAI: `text-embedding-3-small`
- Voyage: `voyage-3-lite`

### Embeddings seem slow (> 500ms)
**Check:**
1. Network latency to provider
2. Try switching to a different provider
3. Consider local LM Studio for < 50ms

### Semantic search not working
**Verify:**
1. Run test script: `pnpm tsx scripts/test-embeddings.ts`
2. Check chunks table has embeddings: `sqlite3 index/memory.sqlite "SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL"`
3. Rebuild index if needed (delete `index/memory.sqlite` and restart agent)

---

## 🔐 Security Notes

- **API keys** are stored in `.env` (git-ignored)
- **Never commit** API keys to version control
- Hosted providers see your query text (use LM Studio for privacy)
- Embeddings are stored locally in SQLite (safe)

---

## 📖 Next Steps

After setting up embeddings:
1. ✅ Run test script to verify
2. ✅ Create a few memory entries
3. ✅ Try semantic queries ("find projects about X")
4. ✅ Compare results with/without embeddings (disable via .env)

For more details on hybrid search (BM25 + vectors), see **CLAUDE.md Phase 4**.
