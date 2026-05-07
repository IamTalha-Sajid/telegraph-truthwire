#!/usr/bin/env node

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import minimist from "minimist";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const argv = minimist(process.argv.slice(2), { boolean: ["quiet", "verbose", "v"] });
const verbose = argv.verbose || argv.v;
const quiet = argv.quiet;
const preferredNetwork = (argv.network || "base").toLowerCase(); // default: base/EVM

const BASE_URL = process.env.RESOURCE_SERVER_URL || "http://localhost:7044";
const DISPATCHER = "/subnet-dispatcher";

// ── Usage ────────────────────────────────────────────────────────────────
function usage() {
  console.log(`
Usage:
  node subnet.js test [--network solana|base] [--verbose|-v]
  node subnet.js zeus [--lat LAT] [--lon LON] [--hours N] [--variable VAR] [--quiet] [--network solana|base] [--verbose|-v]
  node subnet.js bitmind [--image URL|dataURI] [--video URL] [--single] [--quiet] [--network solana|base] [--verbose|-v]

Examples:
  node subnet.js test --network solana -v
  node subnet.js zeus --lat 40.7128 --lon -74.0060 --quiet
  node subnet.js bitmind --single --verbose
`);
  process.exit(1);
}

// ── Parse arguments ──────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") usage();

  const endpoint = args[0].toLowerCase();
  if (!["zeus", "bitmind", "test"].includes(endpoint)) {
    console.error("Unknown endpoint. Use: zeus | bitmind | test");
    usage();
  }

  const rest = args.slice(1);
  const get = (key, def) => {
    const i = rest.indexOf(key);
    if (i === -1) return def;
    return rest[i + 1] ?? def;
  };
  const has = (key) => rest.includes(key);

  if (endpoint === "zeus") {
    const lat = get("--lat", "40.7128");
    const lon = get("--lon", "-74.0060");
    let hours = parseInt(get("--hours", "2"), 10);
    if (Number.isNaN(hours) || hours < 1 || hours > 24) hours = 2;
    const variable = get("--variable", "2m_temperature");
    return { endpoint: "zeus", lat, lon, hours, variable, quiet, verbose, network: preferredNetwork };
  }

  if (endpoint === "bitmind") {
    let image = get("--image", null);
    const video = get("--video", null);
    const single = has("--single");
    if (single && !image && !video)
      image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    if (!image && !video) {
      console.error("BitMind: provide --image <url|dataURI>, --video <url>, or --single");
      process.exit(1);
    }
    return { endpoint: "bitmind", image, video, quiet, verbose, network: preferredNetwork };
  }

  return { endpoint: "test", quiet, verbose, network: preferredNetwork };
}

// ── Create x402 fetch wrapper ────────────────────────────────────────────
async function createX402Fetch(verbose) {
  if (verbose) console.log(`[x402] Creating client — ONLY ${preferredNetwork.toUpperCase()}`);

  const client = new x402Client();

  let originalFetch = fetch;
  if (verbose) {
    originalFetch = async (...args) => {
      console.log("[DEBUG fetch]", args[0], args[1]?.method || "GET");
      try {
        const res = await fetch(...args);
        console.log("[DEBUG fetch response]", res.status, res.url);
        return res;
      } catch (err) {
        console.error("[DEBUG fetch ERROR]", err.message, err.cause?.message || "");
        throw err;
      }
    };
  }

  if (preferredNetwork === "solana" || preferredNetwork === "svm") {
    const solKey = process.env.SOLANA_PRIVATE_KEY?.trim();
    if (!solKey) throw new Error("SOLANA_PRIVATE_KEY missing in .env");
    if (verbose) console.log("[x402] Solana key loaded, length:", solKey.length);
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(solKey));
    registerExactSvmScheme(client, { signer: svmSigner });
    if (verbose) console.log("[x402] Exact SVM scheme registered");
  } else {
    const evmKey = process.env.EVM_PRIVATE_KEY?.trim();
    if (!evmKey) throw new Error("EVM_PRIVATE_KEY missing in .env");
    let formatted = evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`;
    if (verbose) console.log("[x402] EVM key loaded, length:", formatted.length);
    const evmSigner = privateKeyToAccount(formatted);
    registerExactEvmScheme(client, { signer: evmSigner });
    if (verbose) console.log("[x402] Exact EVM scheme registered");
  }

  if (verbose) console.log("[x402] Fetch wrapped with payment");
  return wrapFetchWithPayment(originalFetch, client);
}

// ── Extract tx hash/signature from header ────────────────────────────────
function extractTxHash(headers) {
  const settle = headers.get("x-payment-settle-response");
  if (!settle) return null;

  try {
    const json = JSON.parse(settle);
    return json.tx || json.signature || json.transaction || null;
  } catch {
    // fallback: raw base58 or 0x string
    if (/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(settle)) return settle; // Solana sig
    if (/^0x[a-fA-F0-9]{64}$/.test(settle)) return settle; // EVM hash
    return settle;
  }
}

// ── Shared success handler ───────────────────────────────────────────────
function handleSuccess(res, data, quiet, verbose) {
    const settleHeader = res.headers.get("x-payment-settle-response");
    const txHash = extractTxHash(res.headers);
  
    // ── Always show these when payment happened ─────────────────────────────
    if (settleHeader) {
      console.log("═══════════════════════════════════════════════");
      console.log("          ₿   PAYMENT SETTLED   ₿");
      console.log("═══════════════════════════════════════════════");
      console.log("x-payment-settle-response:", settleHeader);
      if (txHash) {
        console.log("Transaction hash/signature:", txHash);
      }
      console.log("═══════════════════════════════════════════════\n");
    }
  
    // ── API response ────────────────────────────────────────────────────────
    if (!quiet) {
      console.log("API Response");
    }
    console.log(JSON.stringify(data, null, 2));
  
    // ── Verbose extras ──────────────────────────────────────────────────────
    if (verbose) {
      console.log("\n[VERBOSE] Full response headers:");
      console.log(Object.fromEntries(res.headers.entries()));
  
      console.log("\n[VERBOSE] Raw x-payment-settle-response (if any):");
      console.log(settleHeader || "(not present)");
  
      try {
        if (settleHeader) {
          const parsed = JSON.parse(settleHeader);
          console.log("[VERBOSE] Parsed settle payload:", parsed);
        }
      } catch {}
    }
  }

// ── Test endpoint ────────────────────────────────────────────────────────
async function runTest(fetchFn, quiet, verbose) {
  const url = `${BASE_URL}${DISPATCHER}/v1/x402-test`;
  if (verbose) console.log("Querying test →", url);

  const res = await fetchFn(url, { method: "GET", headers: { "Accept": "application/json" } });
  if (!res.ok) {
    if (verbose) console.log("Status:", res.status, "Body:", await res.text());
    process.exit(2);
  }

  const data = await res.json();
  handleSuccess(res, data, quiet, verbose);
}

// ── Zeus endpoint ────────────────────────────────────────────────────────
async function runZeus(opts, fetchFn) {
  const start = Math.floor(Date.now() / 1000);
  const end = start + opts.hours * 3600;
  const url = `${BASE_URL}${DISPATCHER}/v1/18/predict?lat=${opts.lat}&lon=${opts.lon}&start_timestamp=${start}&end_timestamp=${end}&variable=${encodeURIComponent(opts.variable)}`;
  if (!opts.quiet && !opts.verbose) console.log("Querying Zeus →", url);

  const res = await fetchFn(url, { method: "GET", headers: { "Accept": "application/json" } });
  if (!res.ok) {
    console.error("Zeus failed:", res.status, await res.text());
    process.exit(2);
  }

  const data = await res.json();
  handleSuccess(res, data, opts.quiet, opts.verbose);
}

// ── BitMind endpoint ─────────────────────────────────────────────────────
async function runBitmind(opts, fetchFn) {
  const isVideo = !!opts.video;
  const endpointPath = isVideo ? "/v1/34/detect-video" : "/v1/34/detect-image";
  const url = `${BASE_URL}${DISPATCHER}${endpointPath}`;
  const body = isVideo
    ? { video: opts.video, startTime: 0, endTime: 5, fps: 1 }
    : { image: opts.image };

  if (!opts.quiet && !opts.verbose) console.log(`Querying BitMind (${isVideo ? "video" : "image"}) →`, url);

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error("BitMind failed:", res.status, await res.text());
    process.exit(2);
  }

  const data = await res.json();
  handleSuccess(res, data, opts.quiet, opts.verbose);

  if (!opts.quiet) {
    const isAI = data.isAI ?? data.isAi;
    if (isAI != null) console.log("AI-generated:", isAI, "confidence:", data.confidence ?? "n/a");
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
(async function main() {
  const opts = parseArgs();

  const fetchWithPayment = await createX402Fetch(opts.verbose);

  if (opts.endpoint === "test") {
    await runTest(fetchWithPayment, opts.quiet, opts.verbose);
  } else if (opts.endpoint === "zeus") {
    await runZeus(opts, fetchWithPayment);
  } else if (opts.endpoint === "bitmind") {
    await runBitmind(opts, fetchWithPayment);
  }
})();