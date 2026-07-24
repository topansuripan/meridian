# Meridian DLMM Bot - VPS Deployment Guide (Corrected)

Complete step-by-step guide untuk deploy Meridian autonomous liquidity management bot ke VPS Ubuntu 22/24 untuk live trading 24/7.

**⚠️ UPDATED:** Configuration corrected based on local testing (2026-04-10)

## 📋 Prerequisites

Sebelum mulai, pastikan Anda sudah punya:

- ✅ Wallet Solana aktif dengan SOL balance (untuk testing & live trading)
- ✅ VPS Linux (Ubuntu 22 atau 24) dengan akses SSH
- ✅ Terminal/SSH client untuk mengakses VPS

---

## Part 1: Prerequisites Setup (Local)

### 1.1 Daftar OpenRouter API Key

**OpenRouter** adalah platform untuk mengakses berbagai LLM model dengan harga kompetitif.

**Step:**
1. Buka https://openrouter.ai/
2. Klik **Sign Up** → gunakan email Anda
3. Verifikasi email
4. Masuk ke dashboard → **Keys** (sidebar kiri)
5. Klik **Create Key**
6. Berikan nama: `meridian-bot`
7. **Copy API Key** dan simpan

**Model Recommendation:** `claude-3-5-sonnet-20241022`
- Excellent reasoning untuk trading decisions
- Cost-effective (~$0.003 per screening)
- Best untuk beginner

### 1.2 Buat Telegram Bot via BotFather

1. Cari **@BotFather** di Telegram
2. Kirim `/newbot`
3. Berikan nama dan username yang unique
4. Copy bot token
5. **Dapatkan Chat ID:**
   - Buka bot → klik **Start**
   - Kunjungi: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Cari `"chat":{"id":123456789}`
   - Copy ID tersebut

### 1.3 Daftar Helius API Key

1. Buka https://helius.dev/
2. Sign up dengan email
3. Verify email
4. Dashboard → **API Keys**
5. **Create API Key**
6. Copy API Key

---

## Part 2: VPS Setup

### 2.1 Initial VPS Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install dependencies
sudo apt install -y curl git build-essential

# Install Node.js 18+
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 18
nvm use 18

# Verify
node --version
npm --version
```

### 2.2 Buat Non-Root User

```bash
sudo useradd -m -s /bin/bash meridian
sudo su - meridian
```

### 2.3 Setup Firewall

```bash
sudo ufw enable
sudo ufw allow 22/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw status
```

---

## Part 3: Clone & Install Meridian

```bash
cd ~
git clone https://github.com/yunus-0x/meridian.git
cd meridian

# Install dependencies
npm install

# Verify
ls -la
# Should show: package.json, index.js, user-config.example.json, .env.example
```

---

## Part 4: Configuration (CORRECTED)

### 4.1 Create `.env` File

**IMPORTANT:** Use correct variable names!

```bash
cd ~/meridian
nano .env
```

Paste configuration ini:

```env
# ── Wallet ──────────────────────────────────────────────────────────────
WALLET_PRIVATE_KEY=<YOUR_BOT_WALLET_PRIVATE_KEY_BASE58>

# ── Solana RPC ──────────────────────────────────────────────────────────
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<YOUR_HELIUS_API_KEY>

# ── LLM Provider (OpenRouter) ───────────────────────────────────────────
OPENROUTER_API_KEY=sk-or-<YOUR_OPENROUTER_API_KEY>

# ── API Keys ────────────────────────────────────────────────────────────
HELIUS_API_KEY=<YOUR_HELIUS_API_KEY>

# ── Telegram Notifications (optional) ───────────────────────────────────
TELEGRAM_BOT_TOKEN=<YOUR_BOT_TOKEN>
TELEGRAM_CHAT_ID=<YOUR_CHAT_ID>

# ── Trading Mode ───────────────────────────────────────────────────────
DRY_RUN=true
LOG_LEVEL=info
```

**CRITICAL POINTS:**
- `WALLET_PRIVATE_KEY` (NOT `SOLANA_PRIVATE_KEY`)
- `RPC_URL` (NOT `SOLANA_RPC_URL`)
- `DRY_RUN=true` di `.env` file (NOT in `user-config.json`)
- Jangan commit `.env` ke git!

Secure the file:
```bash
chmod 600 .env
```

### 4.2 Create `user-config.json`

```bash
cp user-config.example.json user-config.json
nano user-config.json
```

**For Safe Beginner Testing:**

```json
{
  "preset": "safe",
  "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY",
  "dryRun": false,
  "deployAmountSol": 0.3,
  "maxPositions": 2,
  "minSolToOpen": 0.4,
  "maxDeployAmount": 10,
  "gasReserve": 0.1,
  "positionSizePct": 0.3,
  "strategy": "bid_ask",
  "binsBelow": 50,
  "timeframe": "5m",
  "category": "trending",
  "minTvl": 50000,
  "maxTvl": 500000,
  "minVolume": 1000,
  "minOrganic": 70,
  "minHolders": 1000,
  "minMcap": 500000,
  "maxMcap": 50000000,
  "minBinStep": 100,
  "maxBinStep": 200,
  "minFeeActiveTvlRatio": 0.1,
  "maxBundlePct": 25,
  "maxBotHoldersPct": 25,
  "maxTop10Pct": 50,
  "blockedLaunchpads": [],
  "minTokenAgeHours": 24,
  "minClaimAmount": 10,
  "autoSwapAfterClaim": false,
  "outOfRangeBinsToClose": 15,
  "outOfRangeWaitMinutes": 45,
  "managementIntervalMin": 15,
  "screeningIntervalMin": 60,
  "temperature": 0.3,
  "maxTokens": 2048,
  "maxSteps": 15,
  "managementModel": "openai/gpt-4-mini",
  "screeningModel": "openai/gpt-4-mini",
  "generalModel": "openai/gpt-4-mini",
  "darwinEnabled": true,
  "darwinWindowDays": 30,
  "darwinRecalcEvery": 5,
  "darwinBoost": 1.03,
  "darwinDecay": 0.97
}
```

**Key settings explanation:**

| Setting | Value | Purpose |
|---------|-------|---------|
| `dryRun` | false | Will execute fake trades (monitoring only) |
| `deployAmountSol` | 0.3 | Amount to deploy per position (small for safety) |
| `maxPositions` | 2 | Max positions at same time (limit risk) |
| `managementIntervalMin` | 15 | Check positions every 15 min |
| `screeningIntervalMin` | 60 | Screen for new pools every 60 min |
| `managementModel` | gpt-4-mini | Model untuk keputusan posisi |
| `screeningModel` | gpt-4-mini | Model untuk screening pools |
| `generalModel` | gpt-4-mini | Model untuk general reasoning |

---

## Part 5: Running with PM2

### 5.1 Install PM2

```bash
sudo npm install -g pm2
pm2 --version
```

### 5.2 Create `ecosystem.config.cjs`

```bash
nano ~/meridian/ecosystem.config.cjs
```

Paste:

```javascript
module.exports = {
  apps: [
    {
      name: 'meridian',
      script: './index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        DRY_RUN: 'true'  // Change to 'false' untuk go live
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      ignore_watch: ['node_modules', 'logs', '*.log'],
      max_memory_restart: '500M',
      output: './logs/out.log',
      error: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 5000,
    }
  ]
};
```

### 5.3 Create Logs Directory

```bash
mkdir -p ~/meridian/logs
```

### 5.4 Start Bot

```bash
pm2 start ecosystem.config.cjs
pm2 status

# Output should show:
# id │ name    │ version │ mode │ status  │ restart
# 0  │ meridian│ N/A     │ fork │ online  │ 0
```

### 5.5 Enable Auto-Start

```bash
pm2 save
pm2 startup
# Follow instructions from output
pm2 status
```

---

## Part 6: Monitor & Test

### 6.1 Check Logs

```bash
pm2 logs meridian --lines 100

# Expected output (first run):
# [STARTUP] DLMM LP Agent starting...
# [STARTUP] Mode: DRY RUN
# [STARTUP] Model: openai/gpt-4-mini
# [CRON] Cycles started — management every 15m, screening every 60m
# [CRON] Starting morning briefing
# [AGENT] Step 1/15
```

### 6.2 Monitor Screening Cycle

Tunggu hingga screening cycle berjalan (setiap 60 menit atau sesuai config):

```bash
pm2 logs meridian --follow

# Look for messages:
# [SCREENING] Cycle started
# [SCREENING] Found X opportunities
# [SCREENING] Top candidate: POOL_NAME
```

### 6.3 Monitor Management Cycle

Management cycle setiap 15 menit:

```bash
# Watch untuk:
# [MANAGEMENT] Cycle started
# [MANAGEMENT] Evaluating position X
# [MANAGEMENT] Action: STAY|CLOSE|REDEPLOY
```

### 6.4 Check Resource Usage

```bash
pm2 monit

# Watch untuk:
# Memory: < 300MB
# CPU: < 10% average
```

---

## Part 7: Dry-Run Testing (24-48 Jam)

Jalankan bot dalam mode `DRY_RUN=true` minimal 24-48 jam sebelum go live.

### 7.1 Checklist Dry-Run

- [ ] Bot running stabil (status = online)
- [ ] No crash selama 24+ jam
- [ ] Management cycle berjalan sesuai jadwal
- [ ] Screening cycle berjalan sesuai jadwal
- [ ] Logs tidak ada ERROR (bisa ada WARNING)
- [ ] Memory < 300MB
- [ ] CPU < 10% average
- [ ] DRY_RUN=true di ecosystem.config.cjs

### 7.2 Review Performance

```bash
# Lihat file hasil
ls -lah ~/meridian/

# Expected files:
# lessons.json - Pelajaran dari cycle
# performance-history.json - Histori performance
# user-config.json - Konfigurasi
```

---

## Part 8: Go Live

**HANYA LAKUKAN SETELAH BERHASIL DRY-RUN 24+ HOURS**

### 8.1 Backup Configuration

```bash
cp ~/meridian/user-config.json ~/meridian/user-config.json.backup.$(date +%Y%m%d)
cp ~/.env ~/.env.backup.$(date +%Y%m%d)
```

### 8.2 Switch to Live Mode

```bash
nano ~/meridian/ecosystem.config.cjs
```

Change:
```javascript
env: {
  DRY_RUN: 'false'  // ← Change from 'true' to 'false'
}
```

### 8.3 Restart Bot

```bash
pm2 restart meridian
pm2 logs meridian --follow
```

### 8.4 Monitor First 2 Hours

```bash
pm2 logs meridian --lines 50

# Watch untuk:
# [TRADE] Executing trade...
# [TELEGRAM] Sending notification
# [ERROR] - jika ada error, stop dan revert ke DRY_RUN=true
```

**EMERGENCY REVERT:**
```bash
nano ~/meridian/ecosystem.config.cjs
# Set: DRY_RUN: 'true'
pm2 restart meridian
```

---

## Part 9: Daily Operations

### Daily Check

```bash
pm2 status
pm2 logs meridian --lines 100
```

### Log Rotation Setup

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:rotate 7
```

### Weekly Backup

```bash
tar czf ~/backups/meridian-backup-$(date +%Y%m%d).tar.gz \
  ~/meridian/user-config.json \
  ~/meridian/lessons.json \
  ~/meridian/performance-history.json
```

### Update Bot

```bash
cd ~/meridian
pm2 stop meridian
git pull origin main
npm install
pm2 restart meridian
```

---

## Security Best Practices

### 1. Private Key Management

```bash
# JANGAN gunakan main wallet
# Buat wallet khusus untuk bot
# Transfer hanya amount yang diperlukan

# Backup private key di password manager
# Jangan share atau commit ke git
```

### 2. Protect `.env`

```bash
chmod 600 ~/.env
chmod 600 ~/meridian/.env
```

### 3. SSH Hardening

```bash
# Disable password login
sudo nano /etc/ssh/sshd_config

# Change:
# PermitRootLogin no
# PasswordAuthentication no
# PubkeyAuthentication yes

sudo systemctl restart ssh
```

### 4. Firewall

```bash
sudo ufw status
# Should only allow SSH (port 22)
```

---

## Troubleshooting

### Bot Won't Start

```bash
pm2 logs meridian --err
# Check untuk:
# - WALLET_PRIVATE_KEY invalid
# - OPENROUTER_API_KEY invalid
# - RPC_URL unreachable
```

### No Output from Screening

```bash
# Check interval config
cat ~/meridian/user-config.json | grep Interval

# Manually test screening:
pm2 stop meridian
cd ~/meridian
node -e "import('./index.js').catch(console.error)" &
sleep 30
# kill dengan Ctrl+C
```

### High Memory Usage

```bash
# Reduce maxPositions
nano ~/meridian/user-config.json
# Change: "maxPositions": 2

pm2 restart meridian
```

### API Key Errors

```bash
# Test OpenRouter
curl -X POST https://api.openrouter.ai/api/v1/auth/key \
  -H "Authorization: Bearer YOUR_KEY"

# Test Helius RPC
curl https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

---

## Quick Reference Commands

```bash
# Status
pm2 status
pm2 info meridian

# Logs
pm2 logs meridian --lines 100
pm2 logs meridian --err
pm2 logs meridian --follow

# Control
pm2 stop meridian
pm2 restart meridian
pm2 delete meridian

# Config edit
nano ~/.env
nano ~/meridian/user-config.json
nano ~/meridian/ecosystem.config.cjs

# System
htop
df -h
free -m
```

---

## Version Info

- **Meridian version:** Latest from https://github.com/yunus-0x/meridian
- **Node.js:** 18+
- **PM2:** 5+
- **Ubuntu:** 22 or 24 LTS

---

## Support

- GitHub: https://github.com/yunus-0x/meridian
- OpenRouter Docs: https://openrouter.ai/docs
- Helius Docs: https://helius.dev/docs
- Solana Docs: https://docs.solana.com

---

**Last Updated:** 2026-04-10
**Status:** Verified working with local test (TEST_REPORT.md)
