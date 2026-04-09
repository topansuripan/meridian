import "dotenv/config";
import bs58 from "bs58";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/test-lpagent-zap.mjs --pool <pool> --owner <pubkey> [--strategy BidAsk] [--input-sol 0.2] [--from-bin -456] [--to-bin -406] [--provider JUPITER_ULTRA] [--max-rent-sol 0.057] [--live]",
      "",
      "Env required:",
      "  LPAGENT_API_KEY=...",
    ].join("\n"),
  );
}

const args = parseArgs(process.argv.slice(2));
if (!args.pool || !args.owner) {
  usage();
  process.exit(1);
}

const apiKey = process.env.LPAGENT_API_KEY;
if (!apiKey) {
  console.error("Missing LPAGENT_API_KEY in env.");
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");
const pool = await DLMM.create(connection, new PublicKey(args.pool));
const sdkActiveBin = await pool.getActiveBin();
const amountX = Number(args["amount-x"] ?? 0);
const amountY = Number(args["amount-y"] ?? args["input-sol"] ?? 0.2);
const isSingleSidedSol = amountX <= 0 && amountY > 0;

let fromBinId = Number(args["from-bin"]);
let toBinId = Number(args["to-bin"]);
if ((!Number.isFinite(fromBinId) || !Number.isFinite(toBinId)) && Number.isFinite(Number(args["bins-below"]))) {
  const binsBelow = Number(args["bins-below"]);
  const binsAbove = Number(args["bins-above"] ?? 0);
  fromBinId = sdkActiveBin.binId - binsBelow;
  toBinId = isSingleSidedSol ? sdkActiveBin.binId : sdkActiveBin.binId + binsAbove;
}

if (!Number.isFinite(fromBinId) || !Number.isFinite(toBinId)) {
  console.error("Must provide either --from-bin/--to-bin or --bins-below [--bins-above].");
  process.exit(1);
}

if (fromBinId > toBinId) {
  const originalFrom = fromBinId;
  fromBinId = toBinId;
  toBinId = originalFrom;
}

if (isSingleSidedSol) {
  if (toBinId !== sdkActiveBin.binId) {
    console.error(
      `Single-side SOL requires toBinId to equal the SDK active bin. Expected ${sdkActiveBin.binId}, got ${toBinId}.`,
    );
    process.exit(1);
  }
  if (fromBinId >= toBinId) {
    console.error(
      `Single-side SOL requires fromBinId to be below the SDK active bin. Got ${fromBinId} -> ${toBinId}.`,
    );
    process.exit(1);
  }
}

const payload = {
  stratergy: args.strategy || "BidAsk",
  owner: args.owner,
  inputSOL: Number(args["input-sol"] ?? 0.2),
  percentX: Number(args["percent-x"] ?? 0),
  fromBinId,
  toBinId,
  amountX,
  amountY,
  slippage_bps: Number(args["slippage-bps"] ?? 500),
  provider: args.provider || "JUPITER_ULTRA",
  mode: "zap-in",
};

const url = `https://api.lpagent.io/open-api/v1/pools/${args.pool}/add-tx`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let parsed = text;
try {
  parsed = JSON.parse(text);
} catch {
  // keep raw text
}

const addLiquidityCount =
  Array.isArray(parsed?.data?.addLiquidityTxsWithJito) ? parsed.data.addLiquidityTxsWithJito.length
    : Array.isArray(parsed?.data?.addLiquidityTxs) ? parsed.data.addLiquidityTxs.length
      : 0;
const swapCount =
  Array.isArray(parsed?.data?.swapTxsWithJito) ? parsed.data.swapTxsWithJito.length
    : Array.isArray(parsed?.data?.swapTxs) ? parsed.data.swapTxs.length
      : 0;

const meta = parsed?.data?.meta || {};
const solForX = Number(meta.solForX ?? 0);
const solForY = Number(meta.solForY ?? 0);
const totalSolSpend = solForX + solForY;
const extraSolCost = Math.max(0, totalSolSpend - payload.inputSOL);
const maxRentSol = Number(args["max-rent-sol"] ?? args["max-fee-sol"] ?? 0.057);
const maxAllowedSpend = payload.inputSOL + maxRentSol;
const feeGuardPassed = Number.isFinite(maxRentSol) ? totalSolSpend <= maxAllowedSpend : true;

let submitSummary = null;
if (args.live) {
  if (!feeGuardPassed) {
    submitSummary = {
      attempted: false,
      reason: `Refused to land: simulated spend ${totalSolSpend.toFixed(6)} exceeds deploy+rent ceiling ${maxAllowedSpend.toFixed(6)} (${payload.inputSOL.toFixed(6)} + ${maxRentSol.toFixed(6)})`,
    };
  } else if (addLiquidityCount + swapCount === 0) {
    submitSummary = {
      attempted: false,
      reason: "Refused to land: LPAgent returned no transactions.",
    };
  } else if (!process.env.WALLET_PRIVATE_KEY) {
    submitSummary = {
      attempted: false,
      reason: "Refused to land: WALLET_PRIVATE_KEY is missing.",
    };
  } else {
    const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    const signMany = (arr) =>
      arr.map((serialized) => {
        const bytes = Buffer.from(serialized, "base64");
        try {
          const tx = VersionedTransaction.deserialize(bytes);
          tx.sign([wallet]);
          return Buffer.from(tx.serialize()).toString("base64");
        } catch {
          const tx = Transaction.from(bytes);
          tx.sign(wallet);
          return tx.serialize().toString("base64");
        }
      });

    const addLiquidityTxs =
      parsed?.data?.addLiquidityTxsWithJito?.length > 0
        ? parsed.data.addLiquidityTxsWithJito
        : parsed?.data?.addLiquidityTxs || [];
    const swapTxs =
      parsed?.data?.swapTxsWithJito?.length > 0
        ? parsed.data.swapTxsWithJito
        : parsed?.data?.swapTxs || [];

    const submitRes = await fetch("https://api.lpagent.io/open-api/v1/pools/landing-add-tx", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lastValidBlockHeight: parsed?.data?.lastValidBlockHeight,
        addLiquidityTxsWithJito: signMany(addLiquidityTxs),
        swapTxsWithJito: signMany(swapTxs),
        meta,
      }),
    });
    const submitText = await submitRes.text();
    let submitParsed = submitText;
    try {
      submitParsed = JSON.parse(submitText);
    } catch {
      // keep raw text
    }
    submitSummary = {
      attempted: true,
      ok: submitRes.ok,
      status: submitRes.status,
      response: submitParsed,
    };
  }
}

console.log(JSON.stringify({
  ok: res.ok,
  status: res.status,
  statusText: res.statusText,
  request: {
    pool: args.pool,
    sdkActiveBin: sdkActiveBin.binId,
    isSingleSidedSol,
    strategy: payload.stratergy,
    inputSOL: payload.inputSOL,
    fromBinId: payload.fromBinId,
    toBinId: payload.toBinId,
    provider: payload.provider,
  },
  txSummary: {
    addLiquidityCount,
    swapCount,
  },
  feeEstimate: {
    inputSOL: payload.inputSOL,
    solForX,
    solForY,
    totalSolSpend,
    extraSolCost,
    maxRentSol,
    maxAllowedSpend,
    feeGuardPassed,
  },
  submit: submitSummary,
  response: parsed,
}, null, 2));
