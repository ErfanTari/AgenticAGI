---
code: PLAN.EX-000070
nb: PLAN
type: EX
name: price_dashboard2-spec
status: failed
updated: 2026-04-08
summary: Spec for live price dashboard with crypto, fiat, gold, silver
importance_score: 0
utility_score: 0
usage_count: 0
decay_rate: 0.1
active_page: 1
confidence: 1
last_accessed: 2026-04-07
pinned: 0
source: agent
---

# price_dashboard2-spec

## Price Dashboard Specification

Create a single-file HTML dashboard that displays:
1. Major currency pairs (USD/EUR, USD/GBP, USD/JPY)
2. Cryptocurrencies (BTC, ETH, XRP prices in USD)
3. Precious metals (Gold and Silver spot prices per ounce in USD)

Features:
- Auto-refresh every 60 seconds
- Clean modern UI with cards for each asset class
- Use free public APIs: CoinGecko for crypto, GoldAPI.io or similar for metals/fiat
- Handle API errors gracefully with fallback messages
- Responsive design for mobile/desktop
