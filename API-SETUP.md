# API Setup Guide for Fallback Models

This guide explains how to configure fallback API providers (Anthropic Claude or Google Gemini) for when the local LM Studio model is unavailable.

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

## Option 2: Google Gemini Flash

**Best for:** Fast responses, simple tasks, vision capabilities

### Get Your API Key

1. Go to https://aistudio.google.com/apikey
2. Click **Get API Key**
3. Create new project or select existing
4. Click **Create API Key**
5. Copy the key (starts with `AIza...`)

### Configure

In your `.env` file:

```env
LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.0-flash-exp
GEMINI_API_KEY=AIzaSy-your-actual-key-here
```

### Available Models

- `gemini-2.0-flash-exp` — **Recommended** — Fast, multimodal
- `gemini-1.5-flash` — Stable, production-ready
- `gemini-1.5-pro` — More capable, slower

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
[llm] Primary failed — trying fallback
[llm] Provider: fallback (gemini/gemini-2.0-flash-exp) — 1243ms
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

**Gemini:**
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"test"}]}]}'
```

## Switching Between Providers

Just update `.env`:

```env
# Switch to Gemini
LLM_FALLBACK_PROVIDER=gemini
LLM_FALLBACK_MODEL=gemini-2.0-flash-exp
GEMINI_API_KEY=AIzaSy...

# Or back to Anthropic
# LLM_FALLBACK_PROVIDER=anthropic
# LLM_FALLBACK_MODEL=claude-sonnet-4-6
# ANTHROPIC_API_KEY=sk-ant-...
```

No code changes needed!

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
