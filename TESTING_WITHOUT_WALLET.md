# Testing Meridian WITHOUT a Real Wallet

You can test the bot in multiple ways without needing a real Solana wallet or full API keys.

---

## Option 1: Dummy Test Wallet (Recommended)

**Best for:** Testing full bot logic in dry-run mode

### Generate test wallet:
```bash
node create-test-wallet.js
```

### Add to .env:
```env
WALLET_PRIVATE_KEY=pTuBHKqUgsxNnHVSwp3WVCsP6FA3A2W8yKptEvq3MvSmaoQ7J71eQqNw6x7zfo3oq4HWzCEDjwkpcHm7UbLiapD
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test-key
DRY_RUN=true
LOG_LEVEL=info
```

### Run:
```bash
DRY_RUN=true npm start
```

### What you'll see:
```
[STARTUP] DLMM LP Agent starting...
[STARTUP] Mode: DRY RUN
[CRON] Cycles started — management every 15m, screening every 60m
[CRON] Starting morning briefing
[AGENT] Step 1/15
```

✅ **Tests:**
- Cron cycle scheduling
- Agent loop initialization
- Configuration loading
- Log formatting
- Error handling

❌ **Won't work:**
- Agent reasoning (needs valid OpenRouter API key)
- Wallet balance fetching (wallet has 0 SOL)
- Position management (0 positions)
- Telegram notifications (if enabled)

---

## Option 2: Pool Discovery Testing (No Wallet, No LLM Keys)

**Best for:** Testing screening logic without any credentials

### Run:
```bash
node test/test-screening.js
```

### What it does:
```javascript
// Fetches real-time pool data from Meteora
discoverPools({ page_size: 10, timeframe: "24h", category: "top" })

// Gets detailed info about specific pools
getPoolDetail({ pool_address: "..." })
```

✅ **Tests:**
- Pool discovery API connectivity
- Data parsing
- Screening filters
- No credentials needed!

❌ **Won't work:**
- Agent reasoning
- Position management
- Trading logic

---

## Option 3: Skip Wallet Entirely

**Best for:** Ultra-minimal testing

### .env:
```env
WALLET_PRIVATE_KEY=
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test-key
DRY_RUN=true
```

### Run:
```bash
npm start
```

Bot starts but logs "Wallet not configured" when cycles run.

---

## Option 4: Agent Loop Testing (No Wallet)

**Best for:** Testing LLM reasoning without trading

### Prerequisites:
- Valid OpenRouter API key

### .env:
```env
WALLET_PRIVATE_KEY=
OPENROUTER_API_KEY=sk-or-YOUR-REAL-KEY
RPC_URL=https://api.mainnet-beta.solana.com
DRY_RUN=true
```

### Run:
```bash
node test/test-agent.js
```

---

## Testing Progression

Recommended order to test:

```
1. Pool Discovery Test
   ↓
   npm run test:screen
   (No credentials needed)

2. Dummy Wallet + Full Bot
   ↓
   node create-test-wallet.js
   Add private key to .env
   npm start (with DRY_RUN=true)

3. Real OpenRouter API Key
   ↓
   Update OPENROUTER_API_KEY in .env
   npm start (still DRY_RUN=true)

4. Funding Wallet
   ↓
   Transfer SOL to public key from test wallet
   Switch DRY_RUN=false
   npm start (LIVE MODE)
```

---

## Summary Table

| Test | Wallet | Helius | OpenRouter | What it does |
|------|--------|--------|-----------|--------------|
| Pool discovery | ❌ | ❌ | ❌ | Fetch real pool data |
| Dummy wallet | ✅ Test | ❌ | Test key | See bot startup & cycles |
| Full bot | ✅ Test | ✅ Any | Real key | Full screening & reasoning |
| Live trading | ✅ Real | ✅ Real | Real key | Execute trades |

---

## Troubleshooting

### "WALLET_PRIVATE_KEY not set"
- Either set it (generate with `node create-test-wallet.js`)
- Or leave empty: `WALLET_PRIVATE_KEY=`

### "401 Missing Authentication header"
- This is expected with test OpenRouter key
- Use a real API key or test with pool discovery test

### "Wallet not configured"
- This is expected if WALLET_PRIVATE_KEY is blank
- Bot still runs, just can't check balance

### "RPC request failed"
- Try different RPC URL
- Or wait a minute and retry (rate limits)

---

## Quick Start (No Setup)

```bash
# Test 1: Pool discovery (instant, 10 seconds)
node test/test-screening.js

# Test 2: Full bot startup (15 seconds, then Ctrl+C)
WALLET_PRIVATE_KEY= DRY_RUN=true timeout 10 npm start

# Test 3: Generate wallet + add to .env
node create-test-wallet.js
# (then copy WALLET_PRIVATE_KEY to .env)
# npm start
```

---

## Ready to Deploy?

Once ready for VPS:

1. Generate real wallet (not test)
2. Get real API keys (OpenRouter, Helius)
3. Fund wallet with SOL
4. Deploy to VPS using DEPLOYMENT_GUIDE_CORRECTED.md
