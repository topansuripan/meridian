# ✅ Checklist: Apa Harus Disiapin Sebelum Run Meridian

**Complete setup checklist sebelum jalankan bot**

---

## 📋 Quick Summary

**Untuk run bot, Anda butuh:**
- ✅ Node.js 18+ (sudah ada)
- ✅ Repository cloned (sudah ada)
- ✅ npm packages installed (sudah ada)
- ⏳ **API keys** (optional untuk test)
- ⏳ **Wallet** (test wallet bisa generated)

---

## 🎯 Level 1: Instant Test (5 menit)

**Bisa run SEKARANG tanpa setup apapun:**

```bash
cd /d/aiproject/meridian

# Test 1: Pool discovery API (no auth needed)
node test/test-screening.js

# Test 2: Bot startup (with dummy env)
WALLET_PRIVATE_KEY= DRY_RUN=true timeout 10 npm start
```

✅ **Hasil yang diharapkan:**
- Test 1: Output "Testing Pool Discovery API"
- Test 2: Output "[STARTUP] DLMM LP Agent starting..."

❌ **Kalau error:** Tidak apa-apa, ini normal untuk dummy setup

---

## 🎯 Level 2: Full Dry-Run (30 menit setup)

**Untuk run bot dengan features lengkap (tanpa real trading):**

### Step 1: Generate Test Wallet (5 menit)

```bash
cd /d/aiproject/meridian
node create-test-wallet.js
```

✅ Output:
```
📝 PUBLIC KEY: 57DXH5G3drBxDy9q89gXjCksejE9XvnofFNvWgdWw5nm
🔐 PRIVATE KEY: pTuBHKqUgsxNnHVSwp3WVCsP6FA3A2W8yKptEvq3MvSmaoQ7J71eQqNw6x7zfo3oq4HWzCEDjwkpcHm7UbLiapD
```

💾 **Simpan private key!**

---

### Step 2: Create .env File (10 menit)

```bash
cd /d/aiproject/meridian
nano .env
```

**Paste ini:**
```env
WALLET_PRIVATE_KEY=pTuBHKqUgsxNnHVSwp3WVCsP6FA3A2W8yKptEvq3MvSmaoQ7J71eQqNw6x7zfo3oq4HWzCEDjwkpcHm7UbLiapD
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test-key
HELIUS_API_KEY=test-key
DRY_RUN=true
LOG_LEVEL=info
```

**Save:** Ctrl+S → Ctrl+X (nano)

---

### Step 3: Run Bot! (10 menit monitoring)

```bash
cd /d/aiproject/meridian
npm start
```

✅ **Expected output:**
```
[STARTUP] DLMM LP Agent starting...
[STARTUP] Mode: DRY RUN
[CRON] Cycles started — management every 15m, screening every 60m
[AGENT] Step 1/15
```

✅ **Bot is running!** Let it run untuk 10 menit, lihat logs.

**Stop:** Ctrl+C

---

## 🎯 Level 3: Go Live Setup (2-3 jam setup)

**Untuk trading real dengan API keys:**

### Prerequisites Checklist:

- [ ] OpenRouter account
- [ ] OpenRouter API key
- [ ] Helius account
- [ ] Helius API key
- [ ] Telegram bot (optional)
- [ ] Solana wallet dengan SOL balance

### Setup Steps:

#### 1. Get OpenRouter API Key (10 min)
```
1. Go to https://openrouter.ai/
2. Sign up with email
3. Click "Keys" in sidebar
4. Create key
5. Copy key → save somewhere safe
```

Expected: `sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

---

#### 2. Get Helius API Key (10 min)
```
1. Go to https://helius.dev/
2. Sign up with email
3. Create API key
4. Copy key
```

Expected: `xxxxxxxxxxxxxxxxxxxxxxxx`

---

#### 3. Create/Get Solana Wallet (5-10 min)

Option A: Generate new wallet
```bash
node create-test-wallet.js
# Use private key from output
```

Option B: Use existing wallet
```
- Open Phantom wallet
- Settings → Export private key
- Copy base58 private key
```

---

#### 4. Fund Wallet (Depends)
```
Transfer SOL to wallet address:
- Minimum: 2-5 SOL (for testing)
- Recommended: 10-50 SOL (for real trading)
- Advanced: 100+ SOL (scale up)
```

---

#### 5. Create Real .env (10 min)

```bash
nano .env
```

**Update dengan real keys:**
```env
WALLET_PRIVATE_KEY=<your_real_private_key>
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<YOUR_HELIUS_KEY>
OPENROUTER_API_KEY=sk-or-<YOUR_REAL_KEY>
HELIUS_API_KEY=<YOUR_HELIUS_KEY>
DRY_RUN=false
LOG_LEVEL=info
```

---

#### 6. Setup Configuration (10 min)

```bash
cp user-config.example.json user-config.json
nano user-config.json
```

**Update untuk beginner:**
```json
{
  "deployAmountSol": 0.3,
  "maxPositions": 2,
  "minFeeActiveTvlRatio": 0.15,
  "minOrganic": 70,
  "minHolders": 1000,
  "screeningIntervalMin": 60,
  "managementIntervalMin": 15
}
```

---

#### 7. Dry-Run 24+ Jam (First!)

**JANGAN langsung go live!** Test dulu:

```bash
# Change DRY_RUN=true di .env
WALLET_PRIVATE_KEY=<your_key>
DRY_RUN=true

npm start
# Monitor 24+ jam
# Lihat screening & management cycle jalan
```

**Check:**
- [ ] Screening cycle berjalan setiap 60 menit
- [ ] Management cycle berjalan setiap 15 menit
- [ ] Logs tidak ada ERROR
- [ ] Memory < 300MB
- [ ] Bot tidak crash

---

#### 8. Go Live (Kalau semua OK)

```env
DRY_RUN=false  # Change ini
```

```bash
npm start
# Monitor intensive 2-4 jam pertama
```

---

## 📊 What You Need: Detailed Checklist

### Software ✅ (Sudah Ready)
```
✅ Node.js v22.12.0 (installed)
✅ npm 11.12.1 (installed)
✅ Meridian repo (cloned)
✅ npm packages (installed)
```

### Optional: API Keys ⏳

| API | For | Cost | Required? |
|-----|-----|------|-----------|
| OpenRouter | LLM reasoning | Free tier available | For screening |
| Helius | RPC endpoint | Free tier available | For blockchain |
| Telegram | Notifications | Free | Optional |

### Optional: Wallet ⏳

| Type | How | Cost | For |
|------|-----|------|-----|
| Test wallet | `node create-test-wallet.js` | Free | Testing |
| Real wallet | Generate atau existing | Free | Live trading |

### Optional: Capital ⏳

| Amount | Purpose |
|--------|---------|
| 0 SOL | Testing in dry-run |
| 0.5-2 SOL | First live trade test |
| 5-10 SOL | Regular trading |
| 50+ SOL | Advanced/scaled |

---

## 🚀 Choose Your Path

### Path A: Test SEKARANG (15 menit)
```
Apa butuh: Apa yang ada (0 setup)
Jalankan: node test/test-screening.js
Hasil: Lihat bot bisa connect ke API
```

### Path B: Full Test Local (30 menit)
```
Apa butuh: Generate test wallet + create .env
Jalankan: npm start (DRY_RUN=true)
Hasil: Bot jalan lengkap tanpa trading real
```

### Path C: Go Live (3-4 jam)
```
Apa butuh: API keys + real wallet + SOL balance
Jalankan: npm start (DRY_RUN=false)
Hasil: Bot trading real 24/7
```

---

## 📝 Step-by-Step: Run Sekarang!

### Opsi 1: Quick Test (Right Now - 5 min)

```bash
cd /d/aiproject/meridian

# Test pool discovery
node test/test-screening.js

# Expected output:
# === Testing Pool Discovery API ===
# Fetching top 10 pools (24h)...
```

---

### Opsi 2: Full Bot (15 min)

```bash
cd /d/aiproject/meridian

# Step 1: Generate wallet
node create-test-wallet.js
# Copy WALLET_PRIVATE_KEY dari output

# Step 2: Create .env
nano .env
# Paste:
WALLET_PRIVATE_KEY=<paste_dari_step_1>
RPC_URL=https://api.mainnet-beta.solana.com
OPENROUTER_API_KEY=sk-or-test
HELIUS_API_KEY=test
DRY_RUN=true
LOG_LEVEL=info

# Step 3: Run!
npm start

# Expected output:
# [STARTUP] DLMM LP Agent starting...
# [STARTUP] Mode: DRY RUN
# [CRON] Cycles started...
```

**Stop:** Ctrl+C

---

### Opsi 3: VPS 24/7 (See docs)

Lihat: `/docs/DEPLOYMENT_GUIDE_CORRECTED.md`

---

## ⚠️ Common Mistakes - JANGAN LAKUKAN!

❌ **Mistake 1:** Langsung go live tanpa dry-run
✅ **Do this:** Dry-run 24+ jam dulu

❌ **Mistake 2:** Gunakan main wallet (yang punya banyak uang)
✅ **Do this:** Buat wallet khusus bot, transfer kecil

❌ **Mistake 3:** Deploy besar-besaran langsung
✅ **Do this:** Start 0.3-0.5 SOL per position

❌ **Mistake 4:** Percaya 100% bot tanpa monitor
✅ **Do this:** Check logs setiap hari, adjust config

❌ **Mistake 5:** Share private key ke orang lain
✅ **Do this:** Keep it secure, jangan commit ke git

---

## 🎯 Your Next Action

### Sekarang, Pilih:

**Option A: Pengen cepat lihat bot berjalan?**
```bash
node test/test-screening.js
```
⏱️ 5 menit, lihat bot connect ke blockchain

---

**Option B: Pengen full experience?**
```bash
node create-test-wallet.js
# Create .env
npm start
```
⏱️ 30 menit, lihat bot jalan full dengan dry-run

---

**Option C: Pengen go live real?**
1. Get API keys (30 min)
2. Create .env dengan real keys (10 min)
3. Fund wallet (depends)
4. Dry-run 24 jam
5. Go live

⏱️ 2-3 jam setup + 24 hour testing

---

## ✅ Final Checklist: Ready to Run?

- [ ] Node.js installed (check: `node --version`)
- [ ] Repo cloned (check: `ls -la /d/aiproject/meridian`)
- [ ] npm packages installed (check: `npm list` shows 177 packages)
- [ ] Choose your path (A, B, or C)
- [ ] Ready to run!

---

## 📞 Need Help?

| Problem | Solution |
|---------|----------|
| Node.js not found | Install from https://nodejs.org |
| npm packages not installed | Run `npm install` |
| Private key not working | Generate new one: `node create-test-wallet.js` |
| Bot won't start | Check .env file exists & readable |
| "Missing Authentication" error | Normal with test API keys |

---

**Choose your option above and RUN! 🚀**

Paling gampang? **Option A** (5 min)
Paling lengkap? **Option B** (30 min)
Paling seru? **Option C** (real trading!)

Go! 💪
