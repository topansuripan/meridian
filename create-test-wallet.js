#!/usr/bin/env node

/**
 * Create a test Solana keypair for testing Meridian bot
 * Usage: node create-test-wallet.js
 *
 * This creates a fresh keypair with zero SOL balance.
 * Perfect for testing bot logic in dry-run mode.
 */

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Create a random keypair
const keypair = Keypair.generate();

const secretKey = bs58.encode(keypair.secretKey);
const publicKey = keypair.publicKey.toString();

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  MERIDIAN TEST WALLET CREATED");
console.log("═══════════════════════════════════════════════════════════\n");

console.log("📝 PUBLIC KEY (share this to receive SOL):");
console.log(`   ${publicKey}\n`);

console.log("🔐 PRIVATE KEY (KEEP SECRET!):");
console.log(`   ${secretKey}\n`);

console.log("📋 Add to .env file:");
console.log(`   WALLET_PRIVATE_KEY=${secretKey}\n`);

console.log("⚠️  IMPORTANT:");
console.log("   • This wallet has ZERO balance");
console.log("   • Use for dry-run testing ONLY");
console.log("   • Transfer SOL to public key above if testing live trades");
console.log("   • Never share private key!\n");

console.log("🧪 Test in dry-run mode first:");
console.log("   DRY_RUN=true npm start\n");

console.log("═══════════════════════════════════════════════════════════\n");
