# 🤖 Meridian - Bot Manajemen Liquidity Otomatis untuk Solana

**Dokumentasi Bahasa Indonesia**

---

## 📖 Apa itu Meridian?

**Meridian** adalah bot autonomous (otomatis) yang mengelola posisi liquidity di Meteora DLMM — sebuah protokol liquidity pools di blockchain Solana. Bot ini berjalan 24/7 dan membuat keputusan trading berdasarkan AI (Large Language Model).

Bayangkan Meridian seperti:
- **Asisten trader yang tidak pernah tidur** — memonitor pools, membuka/menutup posisi otomatis
- **Financial advisor berbasis AI** — menganalisis data on-chain dan membuat keputusan berdasarkan reasoning
- **Portfolio manager** — mengelola multiple positions secara bersamaan

---

## 🎯 Apa yang Dilakukan Meridian?

### 1. **Screening (Pencarian Pool Terbaik)**
Bot mencari pool DLMM terbaik dengan:
- Scanning 1000+ pools Meteora setiap 30 menit
- Membandingkan metrics: fee/TVL ratio, organic score, volume, holder count, market cap
- Menganalisis token risk dari OKX (smart money signals)
- Menemukan opportunity dengan risk-reward terbaik

**Contoh:**
- "Pool SOL/BONK memiliki fee/TVL ratio 15% dan organic score 85 — ini bagus!"
- "Jangan buka position di pool ini, token punya red flag dari smart money"

### 2. **Management (Pengelolaan Posisi)**
Untuk setiap position yang sudah dibuka, bot:
- **Monitors** — cek PnL, fees yang terkumpul, status range
- **Claims fees** — mengambil trading fees secara otomatis setiap interval
- **Rebalances** — menyesuaikan range jika harga bergerak
- **Closes** — menutup position jika:
  - PnL positif cukup (take profit)
  - PnL negatif terlalu dalam (stop loss)
  - Range out-of-range lama (posisi tidak earning)
  - Kondisi token berubah

**Contoh:**
- Bot membuka 0.3 SOL di pool SOL/BONK
- Trading fee mengumpul $5 → bot claim otomatis
- Harga BONK turun 40% → bot close position dengan loss, tapi menghemat dari drop lebih dalam

### 3. **Learning (Belajar dari Hasil)**
Setiap posisi yang ditutup dianalisis:
- Bot menyimpan "lessons learned" — apa yang bekerja, apa yang tidak
- Menyesuaikan screening thresholds berdasarkan performance history
- Darwin evolution — threshold berubah adaptif seiring waktu

**Contoh:**
- "Pools dengan fee/TVL > 15% memiliki win rate 70% → naikkan threshold ke 16%"
- "Pools dengan holder < 500 sering jadi rug pull → increase filter ke 1000 holder"

---

## 🔄 Cara Kerja: Dua Agent Berjalan Paralel

### Agent 1: Screening Agent (Setiap 30 Menit)
```
🔍 Lihat 1000+ pools Meteora
   ↓
🧠 AI reason: "Pool mana yang terbaik untuk buy?"
   ↓
💡 Cek: fee/TVL, volume, token safety, APR
   ↓
💰 Jika quality bagus → BUKA POSITION (deploy capital)
```

**Pertanyaan yang dijawab AI:**
- "Apakah fee/TVL ratio mencukupi untuk yield?"
- "Organic score token ini bagus?"
- "Ada smart money masuk ke token ini?"
- "Bin step dan liquidity distribution optimal?"

---

### Agent 2: Management Agent (Setiap 10 Menit)
```
📊 Lihat semua open positions
   ↓
🧠 AI reason: "Apa yang harus dilakukan dengan setiap position?"
   ↓
✅ Untuk setiap position: STAY atau CLOSE?
   ↓
💸 Claim fees, rebalance, atau tutup dengan PnL
```

**Pertanyaan yang dijawab AI:**
- "PnL posisi ini sudah cukup? Ambil profit?"
- "Harga terlalu jauh dari range? Tutup atau rebalance?"
- "Fee terkumpul cukup untuk di-claim?"
- "Ada risk dari token issuer? Tutup saja?"

---

## 📊 Contoh Flow Real: Dari Awal sampai Akhir

```
[Hari 1, 10:00]
🔍 Screening cycle jalan
AI: "Pool SOL/BONK terlihat bagus. Fee/TVL 12%, organic 75, volume tinggi, 2000 holder"
✅ DEPLOY → Bot buka 0.3 SOL di pool ini

[Hari 1, 12:30]
📊 Management cycle jalan
AI: "Position SOL/BONK sudah earning $8 fee. Harga BONK stabil dalam range"
✅ STAY → Biarkan terus earning

[Hari 2, 06:00]
📊 Management cycle jalan
AI: "Fee sudah $15 terkumpul. Claim dan reinvest ke position lain"
✅ CLAIM → Bot claim $15 fee, deposit lagi ke position

[Hari 3, 14:00]
📊 Management cycle jalan
AI: "Harga BONK turun 35% dari entry, di bawah range. Risk besar, close sekarang"
✅ CLOSE → Bot close position
📈 Result: +$12 profit (dari fee) - $8 loss (dari price drop) = +$4 net win

[Bot learns:]
💡 "Pool dengan holder > 1500 lebih aman"
💡 "Bin step 100-150 lebih profitable dari bin step 50"
```

---

## 🛠️ Komponen Teknis

### Data Sources (Sumber Data)
Bot mengambil data dari:

| Sumber | Data | Gunakan |
|--------|------|--------|
| **Meteora DLMM SDK** | Position data, active bin, transaction history | Track positions, calculate PnL |
| **Meteora PnL API** | Yield, fee accrual, APR | Monitor performance |
| **OKX OnchainOS** | Smart money signals, token risk score | Assess token safety |
| **Pool screening API** | Fee/TVL ratio, volume, organic score | Find opportunities |
| **Jupiter API** | Token market cap, launchpad info, audits | Risk assessment |
| **Helius RPC** | Real-time blockchain data | Execute trades |

### AI Models
Bot menggunakan LLM (Large Language Models) dari:
- **Claude 3.5 Sonnet** (recommended untuk reasoning)
- **GPT-4o Mini** (faster, cheaper alternative)
- Diakses via **OpenRouter** (agregator API)

Model berfungsi sebagai "brain" yang:
- Analyze data yang kompleks
- Make decisions dengan reasoning
- Adapt thresholds dari lessons learned

### Execution
Ketika AI memutuskan "buka position":
1. Bot generate transaction (deploy 0.3 SOL ke pool X)
2. Sign dengan private key wallet
3. Broadcast ke blockchain
4. Confirm on-chain

---

## 🎮 Cara Menggunakan

### Mode 1: Autonomous (Bot Berjalan Otomatis)
```bash
npm start
```

Bot berjalan 24/7 tanpa input manusia. Tiap 30 menit screening, tiap 10 menit management.

✅ Best untuk: Set it and forget it

---

### Mode 2: Dry Run (Testing Tanpa Uang)
```bash
DRY_RUN=true npm start
```

Bot berjalan normal TAPI tidak melakukan actual trades. Semua keputusan disimulasi.

✅ Best untuk:
- Testing logika sebelum go live
- Validate configuration
- Lihat bot bekerja tanpa financial risk

---

### Mode 3: Interactive (Chat dengan Bot)
```bash
npm start
# Tunggu prompt, lalu ketik command
> /status                    # Lihat wallet & positions
> /candidates                # Screening manual
> /learn SOL/BONK            # Study pool tertentu
> review my positions        # Chat dengan AI
```

✅ Best untuk: Manual control + AI advice

---

### Mode 4: Terminal Commands (Claude Code)
Kalau punya Claude Code CLI:
```bash
claude
> /screen         # Run screening cycle
> /manage         # Run management cycle
> /balance        # Check balance
> /positions      # List positions
```

---

## 📈 Configuration: Customize Behavior

### Risk Presets
```json
{
  "preset": "safe",           // Minimal risk
  "deployAmountSol": 0.3,     // 0.3 SOL per position
  "maxPositions": 2,          // Max 2 open positions
  "stopLossPct": -50          // Close jika loss > 50%
}
```

### Screening Criteria
```json
{
  "minFeeActiveTvlRatio": 0.1,  // Fee/TVL minimal 10%
  "minOrganic": 70,              // Organic score minimal 70
  "minHolders": 1000,            // Min 1000 holder
  "minMcap": 500000,             // Min $500k market cap
  "maxMcap": 50000000            // Max $50m (anti whale)
}
```

### Cycle Timing
```json
{
  "screeningIntervalMin": 60,    // Screen setiap 60 menit
  "managementIntervalMin": 15    // Manage setiap 15 menit
}
```

Setiap parameter dapat disesuaikan untuk risk tolerance dan strategi Anda.

---

## 💰 Economics: Gimana Bot Earn Money?

### Trading Fees (Utama)
```
Ketika LP di pool:
- 0.3 SOL → Pool menghasilkan fee dari traders
- Fee = (volume × fee_rate) / 2
- Contoh: $10k volume per hari × 0.5% fee = $50 fee per hari
- Bot claim fee otomatis setiap interval
```

### Price Appreciation (Bonus)
```
Jika harga token naik dalam range:
- Entry: $0.10 per token
- Exit: $0.15 per token
- Profit: 50% on top of fees
```

### Risk: Impermanent Loss
```
Jika harga token moves drastis outside range:
- LP tidak earning fee
- Bot close position
- Loss = fees earned - price difference
- Bot tries to minimize dengan OOR detection
```

---

## 🚀 Keuntungan Meridian

### 1. 24/7 Automation
- ✅ Berjalan otomatis tanpa input manusia
- ✅ Tidak perlu ada di depan screen
- ✅ Tidak ada emotional trading

### 2. AI-Powered Decisions
- ✅ Reasoning kompleks terhadap banyak variabel
- ✅ Adaptive thresholds berdasarkan performance
- ✅ Risk assessment otomatis

### 3. Multi-Position Management
- ✅ Manage multiple pools bersamaan
- ✅ Rebalance otomatis
- ✅ Claim fees sistematis

### 4. Learning Loop
- ✅ Bot belajar dari setiap closed position
- ✅ Evolve thresholds otomatis
- ✅ Performance improve over time

### 5. Real-Time Monitoring
- ✅ Check balance & positions kapan saja
- ✅ Telegram notifications
- ✅ Discord signal integration

---

## ⚠️ Risks & Limitations

### Technical Risks
- **RPC downtime** → Bot tidak bisa eksekusi trades
- **Smart contract bugs** → Loss dari protocol exploits
- **Key theft** → Hacker access wallet

### Market Risks
- **Impermanent loss** → Pool fee < price movement loss
- **Token rug pulls** → Token issuer scams
- **Liquidity drought** → Can't exit position quickly

### Configuration Risks
- **Wrong thresholds** → Missing good opportunities atau wrong entries
- **Too aggressive** → Higher loss potential
- **Over-leveraging** → Running out of capital

### Mitigation
- ✅ Test di dry-run 24-48 jam sebelum go live
- ✅ Start dengan small deploy amount (0.3 SOL)
- ✅ Monitor logs regularly
- ✅ Keep private key secure
- ✅ Diversify across multiple pools

---

## 📝 Setup Quick Start

### 1. Prerequisites
```bash
# Install Node.js 18+
node --version

# Clone repo
git clone https://github.com/yunus-0x/meridian
cd meridian

# Install dependencies
npm install
```

### 2. Get API Keys
- **OpenRouter**: https://openrouter.ai → Create key
- **Helius**: https://helius.dev → Create key
- **Telegram**: @BotFather → `/newbot`

### 3. Create Wallet
```bash
node create-test-wallet.js
# Or use existing Solana wallet
```

### 4. Setup Configuration
```bash
# Generate test wallet
node create-test-wallet.js

# Copy private key ke .env
WALLET_PRIVATE_KEY=<your_key>
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
DRY_RUN=true
```

### 5. Test
```bash
# Dry run mode (no real trades)
DRY_RUN=true npm start

# Watch logs
pm2 logs meridian
```

### 6. Go Live
```bash
# Change DRY_RUN=false
# Fund wallet dengan SOL
# npm start
```

---

## 📊 Monitoring: Gimana Follow Bot Bekerja?

### Logs
```bash
pm2 logs meridian --follow

# Expected output:
[SCREENING] Found 10 pools
[SCREENING] Top candidate: SOL/BONK (fee/TVL: 12%)
[MANAGEMENT] Evaluating position ABC...
[TRADE] Closed position with +$4.5 profit
```

### Telegram Notifications
```
Bot send updates ke Telegram:
✅ Screening cycle results
✅ Management actions
✅ Position closed alerts
✅ Fee claims
✅ Errors & warnings
```

### Interactive Commands
```bash
> /status           # Wallet balance & positions
> /candidates       # Top pool candidates
> /learn <pool>     # Study pool analytics
> /thresholds       # Current parameters & stats
```

---

## 🎓 Key Concepts

### DLMM (Dynamic Liquidity Market Maker)
- Alternative ke constant-product AMM (seperti Uniswap)
- Liquidity terkonsentrasi dalam "bins" (price ranges)
- Higher capital efficiency → higher APR untuk LP

### Organic Score
- Metric dari LPAgency yang measure "health" pool
- Considers: volume organic, holder stability, price momentum
- Semakin tinggi = lebih aman untuk LP

### Fee/TVL Ratio
- (24h trading fee) / (total liquidity in pool)
- Semakin tinggi = lebih profitable untuk LP
- Sweet spot: 10-20% untuk sustainable yields

### Out of Range (OOR)
- Position masuk OOR ketika harga move outside LP range
- OOR position tidak earning fee
- Bot automatically close atau rebalance

### PnL (Profit & Loss)
- Combine: fee collected + price appreciation - impermanent loss
- Positive PnL = position winning
- Negative PnL = position losing

---

## 🔗 Links & Resources

| Resource | Link |
|----------|------|
| GitHub | https://github.com/yunus-0x/meridian |
| Solana Docs | https://docs.solana.com |
| Meteora DLMM | https://app.meteora.ag |
| OpenRouter | https://openrouter.ai |
| Helius | https://helius.dev |
| Claude Code | https://claude.ai/code |

---

## ❓ FAQ

**Q: Berapa banyak uang bisa dihasilkan bot?**
A: Tergantung:
- Capital (semakin besar → semakin banyak)
- Pool selection (fee/TVL > 15% → +50% APY possible)
- Market conditions (bull market → higher yields)
- Risk settings (higher risk → higher potential return)

Realistically: 10-50% APY dengan well-tuned settings + good pool selection.

---

**Q: Apakah bisa negative return?**
A: Ya, kemungkinan:
- Impermanent loss > fee earned
- Token rug pull
- Wrong thresholds
- Unlucky market timing

Mitigation: dry-run testing, small position sizes, good configuration.

---

**Q: Bagaimana jika bot crash?**
A:
- PM2 auto-restart otomatis
- Open positions tetap on-chain (aman)
- Bot resume dari saat crash
- Losses dari price movement, bukan dari crash

---

**Q: Apakah perlu monitor 24/7?**
A: Tidak! Bot autonomous. Tapi good practice:
- Check logs 1x per hari
- Monitor wallet balance weekly
- Adjust thresholds monthly

---

**Q: Bisa pakai untuk token lain?**
A:
- Bot designed untuk Solana DLMM
- Could work untuk Meteora pools only
- Can't use untuk Ethereum, Uniswap V4, dll

---

## 📞 Support & Community

- **GitHub Issues**: Report bugs
- **Discord**: Community discussion (jika ada)
- **Twitter**: Follow updates

---

**Meridian = Your AI liquidity manager yang bekerja 24/7** 🚀

Powered by Claude AI + Solana blockchain. Built untuk automated liquidity provisioning.

---

*Last updated: 2026-04-11*
*Dokumentasi Bahasa Indonesia - Meridian Bot v1.0*
