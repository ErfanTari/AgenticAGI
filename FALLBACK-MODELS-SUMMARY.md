# Fallback Models Configuration - Summary

## What Was Added

✅ **Dual Fallback Support** — Both Anthropic and Gemini are now available
✅ **Provider-Aware Routing** — System automatically calls the correct API
✅ **Easy Switching** — Change provider by updating one line in `.env`

## Files Modified

### 1. `config/agent.config.ts`
- Added provider-aware API key selection
- Gemini endpoint: `https://generativelanguage.googleapis.com/v1beta/models`
- Anthropic endpoint: `https://api.anthropic.com/v1/messages`

### 2. `core/llm.ts`
- Added `callGemini()` function for Gemini API
- Updated `callLLM()` to route based on provider
- Converts message format for each API

### 3. `.env`
- Added Gemini configuration options
- Documented both providers with examples
- Shows how to switch between them

## How It Works

```
User Request
     ↓
Primary (LM Studio local model) — tries first
     ↓ (if fails/timeout)
Fallback Provider
     ├── anthropic → callAnthropic()
     └── gemini → callGemini()
     ↓
Response returned to agent
```

## Current Configuration Options

### Keep Anthropic (Current)
```env
LLM_FALLBACK_PROVIDER=anthropic
LLM_FALLBACK_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-your-key
```

### Switch to Gemini
```env
LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.0-flash-exp
GEMINI_API_KEY=AIzaSy-your-key
```

### Or Disable Fallback
```env
# LLM_FALLBACK_PROVIDER=
```

## Quick Start

1. **Get API Key** (choose one or both):
   - Anthropic: https://console.anthropic.com/
   - Gemini: https://aistudio.google.com/apikey

2. **Update `.env`**:
   ```env
   LLM_FALLBACK_PROVIDER=gemini  # or anthropic
   GEMINI_API_KEY=your-actual-key
   ```

3. **Test**:
   ```bash
   # Stop LM Studio to force fallback
   pnpm exec tsx quick-test.ts
   ```

4. **Verify**:
   ```
   [llm] Primary failed — trying fallback
   [llm] Provider: fallback (gemini/gemini-2.0-flash-exp) — 1200ms
   ✅ SUCCESS
   ```

## Recommendations

**For Production:**
- Primary: Qwen 3.5 35B (local, fast, free)
- Fallback: Gemini Flash (cheap, reliable, 15 req/min free)

**For Complex Reasoning:**
- Primary: Qwen 3.5 35B (local)
- Fallback: Claude Sonnet 4.6 (best reasoning)

**For Cost Optimization:**
- Primary: Qwen 3.5 35B (local)
- Fallback: Gemini Flash (cheapest cloud option)

## Next Steps

1. Get your preferred API key
2. Update `.env` with the key
3. Test with quick-test.ts
4. Monitor usage in provider console
5. Optionally set billing alerts

See `API-SETUP.md` for detailed setup instructions!
