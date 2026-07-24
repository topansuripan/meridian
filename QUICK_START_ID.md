# ⚡ Meridian - Quick Start Bahasa Indonesia

**Panduan cepat untuk mulai menggunakan bot**

---

## 📖 Dalam 1 Menit: Apa itu Meridian?

**Meridian** = Bot AI yang:
- 🤖 Otomatis cari pool DLMM terbaik di Solana
- 💰 Buka & tutup posisi liquidity 24/7 tanpa Anda
- 📊 Manage PnL, claim fee, rebalance otomatis
- 🧠 Belajar dari setiap trade → improve strategy

**Hasilnya?** Potential yield 10-50% APY dari trading fee di Meteora DLMM pools.

---

## 🚀 Setup (5 Langkah)

### Langkah 1: Install Node.js
```bash
# Check apakah sudah ada
node --version    # Harus >= 18

# Kalau belum, download dari https://nodejs.org
```

### Langkah 2: Clone & Install Bot
```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### Langkah 3: Buat Wallet Test
```bash
node create-test-wallet.js
# Copy private key yang keluar
```

### Langkah 4: Setup .env
```bash
nano .env
```

Paste konfigurasi:
```env
WALLET_PRIVATE_KEY=<paste_dari_step_3>
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test
DRY_RUN=true
LOG_LEVEL=info
```

### Langkah 5: Jalankan!
```bash
npm start
# Atau dalam dry-run mode (recommended):
DRY_RUN=true npm start
```

---

## 🎮 Commands (Ketika Bot Berjalan)

```
/status          → Lihat wallet balance & positions
/candidates      → List top pool opportunities
/learn <pool>    → Study pool analytics
/stop            → Graceful shutdown
```

Atau chat bebas dengan bot:
```
> "apakah SOL/BONK pool bagus?"
> "tutup semua position dengan loss"
> "berapa fee yang dikumpulin?"
```

---

## 🔧 Configuration: Customize untuk Risk Anda

Edit `user-config.json`:

### Untuk Beginner (Safe)
```json
{
  "deployAmountSol": 0.3,
  "maxPositions": 2,
  "minFeeActiveTvlRatio": 0.15,
  "screeningIntervalMin": 60,
  "managementIntervalMin": 15
}
```

### Untuk Advanced (Aggressive)
```json
{
  "deployAmountSol": 2.0,
  "maxPositions": 5,
  "minFeeActiveTvlRatio": 0.08,
  "screeningIntervalMin": 30,
  "managementIntervalMin": 5
}
```

---

## 📊 Cara Kerja (3 Steps Loop)

### Step 1: SCREEN (Setiap 30 Menit)
```
🔍 Cek 1000+ pools
   ↓
🧠 AI: "Pool mana yang terbaik?"
   ↓
📈 Analisis: fee/TVL, volume, token safety
   ↓
💰 Jika bagus → BUKA POSITION
```

### Step 2: MANAGE (Setiap 10 Menit)
```
📊 Lihat positions yang sudah buka
   ↓
🧠 AI: "Posisi ini bagus untuk STAY atau CLOSE?"
   ↓
✅ Claim fee, rebalance, atau tutup dengan PnL
```

### Step 3: LEARN
```
📈 Setiap posisi ditutup → AI analyze
   ↓
💡 "Pools dengan fee/TVL > 15% lebih profitable"
   ↓
🔄 Threshold otomatis adapt
```

---

## 🧪 Testing Sebelum Go Live

### Test 1: Pool Discovery (1 menit)
```bash
node test/test-screening.js
# Lihat apakah bisa fetch pool data
```

### Test 2: Bot Startup (5 menit)
```bash
DRY_RUN=true npm start
# Press Ctrl+C setelah lihat "Cycles started"
```

### Test 3: Full Dry-Run (24 jam)
```bash
# Buat .env dengan dummy wallet
WALLET_PRIVATE_KEY=pTuBHKqUgsxNnHVSwp3WVCsP6FA3A2W8yKptEvq3MvSmaoQ7J71eQqNw6x7zfo3oq4HWzCEDjwkpcHm7UbLiapD
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test-key
DRY_RUN=true

npm start
# Monitor selama 24 jam → lihat cycle jalan, error ada atau tidak
```

---

## 🎯 Aturan Sebelum Go Live

✅ **HARUS LAKUKAN:**
1. Test dry-run minimal 24-48 jam
2. Lihat semua cycle jalan (screening + management)
3. Check logs — tidak ada ERROR
4. Fund wallet dengan capital yang siap untuk trading
5. Start dengan small deploy amount (0.3-0.5 SOL)

❌ **JANGAN LAKUKAN:**
1. Go live dengan test wallet (0 balance)
2. Langsung deploy besar-besaran
3. Percaya 100% ke AI tanpa monitoring
4. Share private key ke siapa saja
5. Pakai main wallet → gunakan wallet khusus bot

---

## 🚀 Go Live Steps

### 1. Get Real API Keys
- OpenRouter: https://openrouter.ai (create key, pake real key)
- Helius: https://helius.dev (create key, replace test key)
- Telegram (optional): @BotFather → `/newbot`

### 2. Create Real Wallet
```bash
# Option A: Generate baru
node create-test-wallet.js

# Option B: Gunakan existing wallet
# Buat di Phantom atau Solflare
```

### 3. Fund Wallet
```bash
# Minimal untuk test: 2-5 SOL
# Untuk production: 10-100 SOL

# Transfer SOL ke public key wallet bot
```

### 4. Update .env
```env
WALLET_PRIVATE_KEY=<real_private_key>
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<REAL_HELIUS_KEY>
OPENROUTER_API_KEY=sk-or-<REAL_KEY>
DRY_RUN=false
```

### 5. Test Lagi!
```bash
npm start
# Monitor selama 2-4 jam → verify trade execution
```

### 6. Deploy to VPS (Optional)
```bash
# Untuk 24/7 trading, deploy ke VPS
# Lihat: DEPLOYMENT_GUIDE_CORRECTED.md
```

---

## 📈 Monitoring

### Daily
```bash
pm2 status          # Bot running?
pm2 logs meridian   # Any errors?
htop               # Resource usage ok?
```

### Weekly
```bash
cat user-config.json        # Config still correct?
cat lessons.json            # Learning data ada?
cat performance-history.json # Performance baik?
```

### Manual Check
```bash
npm start
> /status        # Wallet balance
> /positions     # Open positions
> /candidates    # Top pools
```

---

## 💡 Tips & Tricks

### Tip 1: Start Small
- Jangan langsung 10 SOL per position
- Start 0.3 SOL, monitor 1-2 minggu
- Slowly increase jika nyaman

### Tip 2: Monitor Logs
```bash
pm2 logs meridian --follow
# Lihat real-time apa yang bot lakukan
```

### Tip 3: Adjust Thresholds
- Kalau bot terlalu conservative → lower min thresholds
- Kalau bot terlalu aggressive → raise min thresholds
- Edit `user-config.json` dan restart

### Tip 4: Claim Fees Manually
```bash
npm start
> /learn <pool>         # Study pool
> claim 50 from xyz     # Claim fee manual
> /status               # Confirm
```

### Tip 5: Diversify Pools
- Jangan semua capital di 1 pool
- Spread 3-5 pools dengan different risks
- Reduce overall risk

---

## ⚠️ Emergency: Gimana Jika Ada Problem?

### Bot Crash
```bash
pm2 restart meridian
# atau
pm2 delete meridian && pm2 start ecosystem.config.cjs
```

### Wrong Decision (Bot ngasal)
```bash
pm2 stop meridian
# Edit user-config.json dengan thresholds lebih strict
pm2 restart meridian
```

### Positions Stuck
```bash
npm start
> /positions           # List semua positions
> close <position_id>  # Close manual
```

### Private Key Exposed
```bash
# Generate wallet baru immediately
node create-test-wallet.js

# Transfer semua dana ke wallet baru
# Update WALLET_PRIVATE_KEY di .env
# Delete old wallet dari Phantom
```

---

## 💰 Earnings Expected

### Best Case (Ideal Conditions)
- 10-15% APY dari fee
- 20-30% APY dari price appreciation
- = 30-45% APY total
- Pada $10k capital = $3-4.5k per tahun

### Average Case
- 5-10% APY dari fee
- 5-10% APY dari price
- = 10-20% APY total
- Pada $10k capital = $1-2k per tahun

### Worst Case
- 0% APY dari fee (no volume)
- -50% dari impermanent loss
- = -50% loss total
- Bot should close sebelum terlalu dalam
- Typically: -5 to -20% worst case

**Key:** Bot designed to minimize losses, maximize gains. Bukan guaranteed profit!

---

## 🛠️ Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot won't start | Check .env, check API keys valid |
| "Wallet not configured" | Add WALLET_PRIVATE_KEY ke .env |
| "401 Missing Auth" | Update OPENROUTER_API_KEY dengan real key |
| No screening cycle runs | Check screeningIntervalMin di config |
| High memory usage | Reduce maxPositions, restart bot |
| Can't connect RPC | Check RPC_URL valid, try different RPC |

---

## 📱 Running on VPS (24/7)

Untuk bot berjalan 24/7 tanpa laptop:

```bash
# 1. SSH ke VPS
ssh user@your_vps_ip

# 2. Clone & install
git clone https://github.com/yunus-0x/meridian
cd meridian && npm install

# 3. Setup .env dengan real keys

# 4. Install PM2
sudo npm install -g pm2

# 5. Start bot
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup

# 6. Monitor remote
pm2 logs meridian --follow
```

Lihat DEPLOYMENT_GUIDE_CORRECTED.md untuk detail lengkap.

---

## 🎓 Learning Resources

- **DOKUMENTASI_ID.md** — Dokumentasi lengkap (bahasa Indonesia)
- **README.md** — Full documentation (English)
- **TESTING_WITHOUT_WALLET.md** — Testing guide tanpa wallet
- **user-config.example.json** — Config examples dengan explanations

---

## 📞 Bantuan

- **GitHub**: https://github.com/yunus-0x/meridian/issues
- **Discord**: (jika ada community)
- **Twitter**: @yunus_0x

---

## ✅ Checklist: Ready to Go Live?

- [ ] Node.js 18+ installed
- [ ] Repo cloned & npm installed
- [ ] Dry-run tested 24+ hours
- [ ] Real API keys obtained
- [ ] Wallet funded dengan capital
- [ ] .env updated dengan real keys
- [ ] user-config.json reviewed & adjusted
- [ ] Monitoring setup (PM2 atau VPS)
- [ ] Private key secured
- [ ] Backup created

Kalau semua ✅ → **Ready to trade!** 🚀

---

**Selamat! Meridian siap bekerja untuk Anda 24/7.**

Nikmati automated liquidity provisioning dengan AI! 🤖💰

*Meridian Bot - Autonomous DLMM Manager for Solana*
