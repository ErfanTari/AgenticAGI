# API Setup Guide for Local + Cloud Models

This guide explains how to configure LM Studio as the default local model and Anthropic Claude or Google Gemini as cloud fallbacks.

## Default Runtime

The project now defaults to a local-first setup:

```env
LLM_ENDPOINT=http://YOUR_MAC_STUDIO:1234/v1/chat/completions
LLM_MODEL=qwen/qwen3.5-35b-a3b
PLANNER_MODEL=qwen/qwen3.5-35b-a3b
EXECUTOR_MODEL=qwen/qwen3.5-35b-a3b

LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.5-flash
GEMINI_API_KEY=AIzaSy-your-actual-key-here
```

`chat.ts` stays local-primary by default.

`pnpm ui` adds a header toggle:
- `local` → LM Studio first, Gemini fallback
- `cloud` → Gemini first, LM Studio fallback

## Why Use Fallback Models?

Fallback models provide redundancy:
- **Local model down?** → Fallback API takes over automatically
- **Local model too slow?** → Fallback API completes the request
- **Complex reasoning needed?** → Can switch to more capable cloud model

## Option 1: Anthropic Claude (Recommended)

**Best for:** Complex reasoning, planning, code generation

### Get Your API Key

1. Go to https://console.anthropic.com/
2. Sign up or log in with your account
3. Navigate to **API Keys** section
4. Click **Create Key**
5. Copy the key (starts with `sk-ant-...`)

### Configure

In your `.env` file:

```env
LLM_FALLBACK_PROVIDER=anthropic
LLM_FALLBACK_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-api03-your-actual-key-here
```

### Available Models

- `claude-opus-4-6` — Most capable, slower, more expensive
- `claude-sonnet-4-6` — **Recommended** — Balanced speed/quality
- `claude-haiku-4-5` — Fastest, cheapest, good for simple tasks

### Pricing (as of 2025)

- **Sonnet 4.6:** $3/million input tokens, $15/million output tokens
- **Free tier:** $5 credit to start

## Option 2: Google Gemini

**Best for:** Strong reasoning without LM Studio, fast setup through Google's OpenAI-compatible endpoint

### Get Your API Key

1. Go to https://aistudio.google.com/apikey
2. Click **Get API Key**
3. Create new project or select existing
4. Click **Create API Key**
5. Copy the key (starts with `AIza...`)

### Configure

To use Gemini as the cloud fallback behind LM Studio:

```env
LLM_ENDPOINT=http://YOUR_MAC_STUDIO:1234/v1/chat/completions
LLM_MODEL=qwen/qwen3.5-35b-a3b
PLANNER_MODEL=qwen/qwen3.5-35b-a3b
EXECUTOR_MODEL=qwen/qwen3.5-35b-a3b

LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.5-flash
GEMINI_API_KEY=AIzaSy-your-actual-key-here
```

If you want Gemini as the active model outside the UI toggle:

```env
LLM_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
LLM_MODEL=gemini-2.5-flash
GEMINI_API_KEY=AIzaSy-your-actual-key-here
PLANNER_MODEL=gemini-2.5-flash
EXECUTOR_MODEL=gemini-2.5-flash
```

If you want Gemini only as a fallback behind another primary:

```env
LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.5-flash
GEMINI_API_KEY=AIzaSy-your-actual-key-here
```

### Available Models

- `gemini-2.5-flash` — **Recommended** — fast, stable, OpenAI-compatible
- `gemini-2.5-pro` — stronger reasoning, slower and more expensive
- `gemini-2.0-flash` — lighter fallback if you need older compatibility

### Pricing (as of 2025)

- **Flash models:** Free tier includes 15 requests/minute
- **Paid:** $0.075/million input tokens, $0.30/million output tokens

## Testing Your Setup

After configuring your API key, test it:

```bash
# Force fallback by stopping LM Studio, then run:
pnpm exec tsx quick-test.ts
```

You should see:
```
[llm] Provider: primary (gemini-2.5-flash) — 1243ms
```

## Security Best Practices

### Never Commit API Keys

Your `.env` file is already in `.gitignore`, but double-check:

```bash
git status  # Should NOT show .env
```

### Rotate Keys Regularly

- Anthropic: https://console.anthropic.com/settings/keys
- Gemini: https://aistudio.google.com/apikey

### Monitor Usage

- **Anthropic:** https://console.anthropic.com/settings/billing
- **Gemini:** https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas

## Troubleshooting

### Error: "401 Unauthorized"

- Check API key is correct (no extra spaces)
- Verify key hasn't expired
- Ensure billing is set up (if past free tier)

### Error: "429 Rate Limit"

- You've exceeded free tier limits
- Wait 60 seconds and retry
- Consider upgrading to paid tier

### Error: "All LLM providers unreachable"

- Both local and fallback failed
- Check internet connection
- Verify LM Studio is running for primary
- Test API key with curl:

**Anthropic:**
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[{"role":"user","content":"test"}]}'
```

**Gemini (OpenAI-compatible):**
```bash
curl "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"test"}],"max_tokens":20}'
```

## Switching Between Providers

For CLI/runtime defaults, update `.env`:

```env
# Switch primary to Gemini
LLM_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
LLM_MODEL=gemini-2.5-flash
GEMINI_API_KEY=AIzaSy...

# Or switch back to LM Studio primary
LLM_ENDPOINT=http://YOUR_MAC_STUDIO:1234/v1/chat/completions
LLM_MODEL=qwen/qwen3.5-35b-a3b
PLANNER_MODEL=qwen/qwen3.5-35b-a3b
EXECUTOR_MODEL=qwen/qwen3.5-35b-a3b
```

For the web UI, use the provider buttons in the header. No restart is required.

## Cost Optimization Tips

1. **Use local models first** — Fallback only triggers on failure
2. **Choose appropriate tier:**
   - Simple tasks → Haiku/Flash
   - Complex reasoning → Sonnet
   - Critical planning → Opus/Pro
3. **Monitor usage** — Set billing alerts
4. **Cache responses** — Future enhancement (not yet implemented)

## Support

- **Anthropic Docs:** https://docs.anthropic.com/
- **Gemini Docs:** https://ai.google.dev/docs
- **Issues:** Report in project GitHub
