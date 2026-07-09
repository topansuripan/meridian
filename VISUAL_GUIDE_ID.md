# 📊 Meridian - Visual Guide (Bahasa Indonesia)

Penjelasan Meridian dengan diagram & visualisasi

---

## 🎯 Meridian dalam Gambar

### Apa itu Meridian?

```
┌─────────────────────────────────────────────────────────────┐
│                    MERIDIAN BOT                              │
│                                                               │
│  🤖 AI Brain (Claude AI)                                      │
│     ↓                                                          │
│  📊 Analyzes pools & positions                               │
│     ↓                                                          │
│  💰 Makes trading decisions                                  │
│     ↓                                                          │
│  🔄 Executes trades 24/7                                     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Peran Meridian

```
┌──────────────────────┐
│   Solana Blockchain  │
│   (Meteora DLMM)     │
└──────────┬───────────┘
           │
           ↓
┌──────────────────────┐       ┌──────────────────┐
│  1000+ DLMM Pools    │←─────→│  Meridian Bot    │
│                      │       │  (AI-Powered)    │
│  Fee: 0.01% - 1%    │       │                  │
│  APY: 5% - 100%     │       │  Screens: 30min  │
│  Volume: High/Low   │       │  Manages: 10min  │
└──────────────────────┘       │  Learns: Always  │
                               └──────────────────┘
           ↓                            ↓
      Many pools             Smart selection
      Low margin              High margin
      Hard to choose          Auto optimization
```

---

## 🔄 Dua Agent Bekerja Paralel

```
┌────────────────────────────────────────────────────────────┐
│              MERIDIAN OPERATING SYSTEM                      │
├────────────────────────────────────────────────────────────┤
│                                                              │
│  SCREENING AGENT                  MANAGEMENT AGENT          │
│  (Every 30 min)                   (Every 10 min)            │
│  ✓ Scan 1000+ pools               ✓ Check all positions    │
│  ✓ Find best opportunities        ✓ Claim fees              │
│  ✓ Analyze token risk             ✓ Rebalance ranges       │
│  ✓ Deploy capital if good         ✓ Close losing positions  │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Learning Engine (Always Running)             │   │
│  │  • Saves lessons from closed positions               │   │
│  │  • Evolves screening thresholds                      │   │
│  │  • Improves decision making                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└────────────────────────────────────────────────────────────┘
```

---

## 📈 Lifecycle: Dari Start sampai End

```
DAY 1 (10:00 AM)

    🔍 SCREENING        AI Decision         ✅ OPEN
    [Find pools] ─────→ [SOL/BONK bagus!] ─→ [Deploy 0.3 SOL]

    Status: 📊 POSITION OPEN
            Entry: SOL = $100, BONK = $0.10
            Fee earned: $0


DAY 1 (12:30 PM)

    📊 MANAGEMENT       AI Decision         ✅ HOLD
    [Check position] ──→ [PnL +$8, hold] ──→ [No action]

    Status: 📊 POSITION OPEN
            Entry: SOL = $100, BONK = $0.10
            Fee earned: $8 (hold)
            PnL: +$8


DAY 2 (08:00 AM)

    📊 MANAGEMENT       AI Decision         ✅ CLAIM
    [Check position] ──→ [Fee = $15, claim] → [Harvest fee]

    Status: 📊 POSITION OPEN
            Entry: SOL = $100, BONK = $0.10
            Fee earned: $15 (claimed)
            PnL: +$8 (still holding)


DAY 3 (02:00 PM)

    📊 MANAGEMENT       AI Decision         ⚠️ CLOSE
    [Check position] ──→ [Harga drop 40%]  → [Close now]
                         [OOR + high risk]

    Status: 📊 POSITION CLOSED
            Entry: SOL = $100, BONK = $0.10
            Exit:  SOL = $100, BONK = $0.06
            Fee earned: $15
            Loss: -$8 (0.04 BONK × 200 count)
            NET: +$7 profit


🧠 BOT LEARNS:
    ✓ Pools dengan 1500+ holder lebih aman
    ✓ Fee/TVL 15%+ lebih profitable
    ✓ Close position cepat saat OOR = better risk management
```

---

## 💰 Money Flow: Gimana Bot Earn?

```
┌───────────────────────────────────────────────────────┐
│            TRADING FEE MECHANISM                      │
├───────────────────────────────────────────────────────┤
│                                                        │
│  Traders swap di pool:                               │
│  "Saya tukar 10 BONK ke SOL"                        │
│                                                        │
│  Pool charges fee:                                   │
│  Fee = 10 BONK × 0.5% = 0.05 BONK                  │
│                                                        │
│  Fee distribusi ke LPs:                              │
│  My LP share = 30% (my liquidity ÷ total pool)     │
│  My fee = 0.05 BONK × 30% = 0.015 BONK             │
│                                                        │
│  Repeat setiap hari → accumulate fee                 │
│                                                        │
└───────────────────────────────────────────────────────┘


CONTOH REALISTIC:

    Capital:        0.5 SOL = $50
    Fee APY:        12% per tahun
    Daily earn:     $50 × 12% ÷ 365 = $0.016 per hari
    Monthly earn:   $0.016 × 30 = $0.48 per bulan
    + Price gain:   Jika BONK naik → additional profit


BEST CASE:
    Capital:        10 SOL = $1000
    Pool quality:   Fee/TVL 20% (excellent)
    Organic score:  85+ (safe)
    Fee APY:        40% per tahun (possible)
    Daily earn:     $1000 × 40% ÷ 365 = $1.10 per hari
    Monthly earn:   $1.10 × 30 = $33 per bulan
```

---

## 🧠 Decision Tree: Gimana AI Berfikir?

```
┌─────────────────────────────────────────────────────────────┐
│  SCREENING DECISION TREE                                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Question 1: Fee/TVL ratio > 10%?                          │
│              NO  → ❌ SKIP (not enough fee)                 │
│              YES ↓                                            │
│                                                               │
│  Question 2: Organic score > 70?                            │
│              NO  → ❌ SKIP (risky token)                    │
│              YES ↓                                            │
│
│  Question 3: Holder count > 1000?                           │
│              NO  → ❌ SKIP (rug pull risk)                  │
│              YES ↓                                            │
│                                                               │
│  Question 4: Market cap $500k - $50m?                       │
│              NO  → ❌ SKIP (too small/big)                  │
│              YES ↓                                            │
│                                                               │
│  Question 5: Smart money actively trading?                  │
│              NO  → ⏸️  MAYBE (low volume)                  │
│              YES ↓                                            │
│                                                               │
│  ✅ PASS ALL CHECKS                                         │
│  AI final reasoning: "This pool meets all criteria"         │
│  ACTION: 💰 DEPLOY 0.3 SOL                                  │
│                                                               │
└─────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────┐
│  MANAGEMENT DECISION TREE                                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  For each open position:                                    │
│                                                               │
│  Question 1: PnL > +20% (take profit)?                     │
│              YES → 💰 CLOSE POSITION                        │
│              NO  ↓                                            │
│                                                               │
│  Question 2: PnL < -30% (stop loss)?                       │
│              YES → ⛔ CLOSE POSITION                        │
│              NO  ↓                                            │
│                                                               │
│  Question 3: Position out-of-range > 30 min?               │
│              YES → ⚠️  CLOSE POSITION                      │
│              NO  ↓                                            │
│                                                               │
│  Question 4: Token showing red flags?                       │
│              YES → ⛔ CLOSE POSITION                        │
│              NO  ↓                                            │
│                                                               │
│  Question 5: Fee accumulated > $5?                          │
│              YES → 💸 CLAIM FEE                             │
│              NO  ↓                                            │
│                                                               │
│  ✅ PASS ALL CHECKS                                         │
│  AI final decision: "Position healthy, hold & monitor"      │
│  ACTION: ✓ STAY                                             │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Data Flow: Dari Blockchain ke AI

```
REAL-TIME DATA FLOW

    Blockchain (Solana)
    ├─ Meteora DLMM SDK
    │  ├─ Pool address
    │  ├─ Active bin
    │  └─ Position data
    │
    ├─ Meteora PnL API
    │  ├─ Fee accrued
    │  ├─ Yield APY
    │  └─ Position PnL
    │
    ├─ OKX OnchainOS
    │  ├─ Smart money activity
    │  └─ Token risk score
    │
    ├─ Pool Screening API
    │  ├─ Fee/TVL ratio
    │  ├─ Volume 24h
    │  └─ Organic score
    │
    └─ Jupiter API
       ├─ Token market cap
       ├─ Price history
       └─ Audit status

    ↓ (Aggregated into prompt)

    LLM (Claude AI via OpenRouter)
    ├─ Analyze all data
    ├─ Reason about decisions
    └─ Generate actions

    ↓ (Execute on blockchain)

    Transactions
    ├─ Open position
    ├─ Close position
    └─ Claim fees
```

---

## 🎮 Interaction Models: 3 Cara Pakai Bot

```
MODE 1: AUTONOMOUS
┌─────────────────────┐
│  Run Bot             │
│  npm start           │
└─────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  🤖 Bot runs 24/7                       │
│     No human input needed                │
│     Screening: Every 30 min              │
│     Management: Every 10 min             │
│     Learns: Continuous                   │
└─────────────────────────────────────────┘


MODE 2: INTERACTIVE
┌─────────────────────┐
│  Run Bot             │
│  npm start           │
└─────────────────────┘
         ↓
    [Prompt appears]
    > /status      ← You ask questions
    > /candidates
    > /learn
    > custom query

         ↓
┌──────────────────────────────────┐
│  AI responds + bot keeps running  │
│  Hybrid mode: auto + manual       │
└──────────────────────────────────┘


MODE 3: TERMINAL COMMANDS
┌─────────────────────┐
│  claude code CLI     │
│  cd meridian        │
│  claude             │
└─────────────────────┘
         ↓
    /screen    ← Slash commands
    /manage
    /balance
    /positions
    /candidates

         ↓
┌──────────────────────────────────┐
│  Claude AI runs agents            │
│  Show results in terminal         │
│  Then exit                        │
└──────────────────────────────────┘
```

---

## 📱 System Architecture

```
┌──────────────────────────────────────────────────────────┐
│                 MERIDIAN ARCHITECTURE                    │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  Clients                  Core Logic          Blockchain   │
│  ┌──────────┐            ┌──────────┐        ┌─────────┐  │
│  │ CLI      │────────────│ Agent    │───────→│ Solana  │  │
│  │ REPL     │            │ Loop     │        │ RPC     │  │
│  │ Telegram │────────────│ Manager  │        │ Helius  │  │
│  │ Discord  │            │ Screener │        │         │  │
│  │ Claude   │            │ Learner  │        │         │  │
│  │ Code     │            │ Executor │        │ Meteora │  │
│  └──────────┘            └──────────┘        │ DLMM    │  │
│       ↑                        ↑              └─────────┘  │
│       └────────────────────────┘                   ↑       │
│              (Node.js App)         (Transaction   │       │
│                                     Broadcast)    │       │
│                                                    │       │
│                          LLM (AI Brain)            │       │
│                          ┌──────────────────┐      │       │
│                          │ OpenRouter API   │──────┘       │
│                          │ Claude 3.5 Sonnet         │       │
│                          │ (Reasoning)              │       │
│                          └──────────────────┘       │       │
│                                                     │       │
└──────────────────────────────────────────────────────────┘
```

---

## 🎓 Key Metrics Explained

```
FEE/TVL RATIO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(24h trading fee) / (total liquidity in pool)

Example:
  Fee collected: $200
  Liquidity in pool: $2000
  Fee/TVL: 200/2000 = 10%

Interpretation:
  10% = Decent yield for 1 day
  Annualized = 10% × 365 = 3650% APY (too optimistic)
  Actually: 10% APY realistic after 1 month average


ORGANIC SCORE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Health metric dari LPAgency (0-100)

High (80+):
  ✓ Consistent organic volume
  ✓ Real traders using pool
  ✓ Token fundamentals good

Low (<50):
  ✗ Mostly bots trading
  ✗ Artificial volume
  ✗ Risky token


IMPERMANENT LOSS (IL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Loss from price movement while being LP

Example:
  Enter: SOL = $100, Token = $1 (ratio 1:100)
  Later: SOL = $150, Token = $1.5 (ratio 1:100 SAME!)
  Price ratio didn't change → 0% IL

  But:
  Enter: SOL = $100, Token = $1
  Later: SOL = $100, Token = $2 (ratio 1:50)
  Token doubled relative to SOL → IL happens
  My position now underwater


PNL (PROFIT & LOSS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total profit/loss from position

Formula:
  PnL = (Fee Earned) + (Price Appreciation) - (Impermanent Loss)

Example:
  Fee earned: +$15
  Price appreciation: +$5
  Impermanent loss: -$8
  PnL = +15 +5 -8 = +$12 (profit!)
```

---

## 🚀 Getting Started Flow

```
START
  ↓
[Install Node.js]
  ↓
[Clone repo]
  ↓
[npm install]
  ↓
[Test screening]
  npm run test:screen
  ↓
[Create wallet]
  node create-test-wallet.js
  ↓
[Setup .env]
  nano .env
  ↓
[Test dry-run]
  DRY_RUN=true npm start
  (monitor 24+ hours)
  ↓
[Get real keys]
  OpenRouter API key
  Helius API key
  ↓
[Fund wallet]
  Transfer SOL to bot wallet
  ↓
[Go live]
  DRY_RUN=false npm start
  ↓
[Monitor & profit!]
  Check logs daily
  Adjust config as needed
  ↓
RUNNING 24/7
```

---

## 📈 Success Path

```
FIRST MONTH:
  ├─ Testing & learning
  ├─ Small capital (1-5 SOL)
  ├─ Safe configuration
  ├─ Expected return: 5-10%
  └─ Main goal: Understand bot behavior

SECOND MONTH:
  ├─ Increase capital if confident
  ├─ Adjust thresholds based on data
  ├─ Mix of safe & aggressive pools
  ├─ Expected return: 10-20%
  └─ Main goal: Optimize settings

THIRD+ MONTH:
  ├─ Scale up
  ├─ Fine-tune for YOUR strategy
  ├─ Diversify across multiple pools
  ├─ Expected return: 15-40%+
  └─ Main goal: Maximize sustainable yield
```

---

**Meridian = Automation + AI + Crypto = Passive Income Stream** 💰🤖

*Visual Guide untuk Meridian Bot v1.0*
