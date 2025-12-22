#!/usr/bin/env node
// @ts-nocheck
require('dotenv').config();
/** @type {any} */
const axios = require('axios');

// Helius RPC configuration: support rotating API keys and RPC URLs to reduce pressure
// Provide comma-separated lists in env: HELIUS_API_KEYS and HELIUS_RPC_URLS
const _HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.HELIUS_RPC || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
// Fallback to single default when none provided
if(_HELIUS_KEYS.length===0){ const k = process.env.HELIUS_API_KEY || ''; if(k) _HELIUS_KEYS.push(k); }
if(HELIUS_RPC_URLS.length===0){ HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/'); }
// internal counter for round-robin
let heliusCallCounter = 0;
// Basic validation: detect obvious placeholder keys/urls to help debugging when no mints appear
function looksLikePlaceholderKey(k){ if(!k) return true; const up = String(k).toUpperCase(); if(up.includes('KEY1')||up.includes('KEY2')||up.includes('KEY')||up.includes('XXX')||up.includes('PLACEHOLDER')) return true; return false; }
function looksLikeUrl(u){ try{ return String(u).toLowerCase().startsWith('http'); }catch(e){ return false; } }
const badKeys = _HELIUS_KEYS.filter(looksLikePlaceholderKey);
const badUrls = HELIUS_RPC_URLS.filter(u => !looksLikeUrl(u));
if(badKeys.length > 0 || badUrls.length > 0){
  console.error('Helius configuration validation failed: please set real API keys and valid RPC URLs via environment variables.');
  if(badKeys.length>0) console.error('  Detected placeholder-ish HELIUS_API_KEYS:', JSON.stringify(_HELIUS_KEYS));
  if(badUrls.length>0) console.error('  Detected invalid HELIUS_RPC_URLS:', JSON.stringify(HELIUS_RPC_URLS));
  console.error('Example (bash):');
  console.error('  HELIUS_API_KEYS="yourKey1,yourKey2" HELIUS_RPC_URLS="https://mainnet.helius-rpc.com/,https://rpc2.example/" node scripts/sequential_10s_per_program.js');
  // fail fast so user notices configuration issue instead of silent RPC errors
  process.exit(1);
}
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
// EventEmitter for in-process notification handling
const notifier = new EventEmitter();
// export notifier when required as a module
try{ module.exports = module.exports || {}; module.exports.notifier = notifier; }catch(e){}
// in-memory per-user notification queues (temporary background memory)
try{ if(!global.__inMemoryNotifQueues) global.__inMemoryNotifQueues = new Map(); }catch(e){}
const INMEM_NOTIF_MAX = Number(process.env.NOTIF_INMEM_MAX || 50);
// optional helper: attempt to require message builder
let _tokenUtils = null;
try{ _tokenUtils = require('../src/utils/tokenUtils'); }catch(e){}

const PROGRAMS = [
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
];

// RULES: per-program allowed transaction kinds. This map controls which transaction kinds
// are normally processed for each program during the sequential listener.
// To avoid missing any real mint launches we define a small set of kinds that must
// always be processed regardless of the per-program rule. This allows us to be
// conservative (filter noisy swaps) while never skipping explicit mint initializations.
const RULES = {
  // Make default inclusive: capture explicit initializes and swap events to avoid missing real launches
  default: { allow: ['initialize','pool_creation','swap'] },
  // Keep rules minimal for the selected programs
  '9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp': { allow: ['initialize','pool_creation','swap'] },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { allow: ['initialize','pool_creation','swap'] }
};

// Kinds that should always be processed to avoid dropping real mint launches.
const ALWAYS_PROCESS_KINDS = new Set(['initialize']);

const DENY = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','So11111111111111111111111111111111111111112','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);

// Configurable timings (ms) via environment variables
const PER_PROGRAM_DURATION_MS = Number(process.env.PER_PROGRAM_DURATION_MS) || 10000;
const INNER_SLEEP_MS = Number(process.env.INNER_SLEEP_MS) || 120;
const POLL_SLEEP_MS = Number(process.env.POLL_SLEEP_MS) || 800;
const CYCLE_SLEEP_MS = Number(process.env.CYCLE_SLEEP_MS) || 2000;
// Increase defaults during testing to avoid overly-strict rejection of valid mints
const SIG_BATCH_LIMIT = Number(process.env.SIG_BATCH_LIMIT) || 20;
// raise default to allow checking a few historical signatures for accuracy
const MINT_SIG_LIMIT = Number(process.env.MINT_SIG_LIMIT) || 8;
// Freshness and first-signature matching configuration
// Proposal 1: widen default window slightly to capture marginally delayed mints
// Increase sensible defaults so collector is less likely to reject near-edge mints
// Proposal1: widen the age/window tolerances so marginally-delayed mints are accepted
const MAX_MINT_AGE_SECS = Number(process.env.MAX_MINT_AGE_SECS) || 30; // seconds
// Collector: allow accumulating a small number of freshly-accepted mints and
// printing them as a single JSON array. Useful for short-lived runs/testing.
const COLLECT_MAX = Number(process.env.COLLECT_MAX) || 3;
const EXIT_ON_COLLECT = (process.env.EXIT_ON_COLLECT === 'false') ? false : true;
const LATEST_COLLECTED = [];
// Capture-only mode: when true the listener writes a minimal capture JSON to disk
// and skips per-user enrichment/strategy analysis (reduces latency to print/save).
const CAPTURE_ONLY = (process.env.CAPTURE_ONLY === 'true');
// TTL for caching first-signature probes (ms). Configurable via env, with a dynamic
// adjustment when upstream rate-limits increase to reduce probe pressure.
const FIRST_SIG_TTL_MS = Number(process.env.FIRST_SIG_TTL_MS) || 15000;
let _lastFirstSigCleanup = 0;
function computeFirstSigTTL(){
  try{
    const base = Number(process.env.FIRST_SIG_TTL_MS) || FIRST_SIG_TTL_MS;
    // If we observe 429s, increase TTL to reduce probe frequency (capped multiplier)
    const rateHits = Math.min(RPC_STATS.rateLimit429 || 0, 5);
    const multiplier = 1 + (rateHits * 0.5); // each 429 increases TTL by 50%, up to 5 hits
    return Math.max(1000, Math.floor(base * multiplier));
  }catch(e){ return FIRST_SIG_TTL_MS; }
}
const FIRST_SIG_MATCH_WINDOW_SECS = Number(process.env.FIRST_SIG_MATCH_WINDOW_SECS) || 12; // allowed delta between firstSig.blockTime and tx.blockTime
const FIRST_SIG_CACHE = new Map(); // mint -> { sig, blockTime, ts }

async function getFirstSignatureCached(mint){
  if(!mint) return null;
  try{
    const now = Date.now();
    const ttl = computeFirstSigTTL();
    const cached = FIRST_SIG_CACHE.get(mint);
    if(cached && (now - cached.ts) < ttl) return { sig: cached.sig, blockTime: cached.blockTime };
    // occasional cleanup of stale cache entries to avoid unbounded growth
    try{
      if(now - _lastFirstSigCleanup > 60000){
        _lastFirstSigCleanup = now;
        for(const [k,v] of FIRST_SIG_CACHE.entries()){
          if(!v || !v.ts || (now - v.ts) > (ttl * 3)) FIRST_SIG_CACHE.delete(k);
        }
      }
    }catch(e){}
    // attempt a single lightweight probe (keep retries minimal to avoid rate limit)
    try{
      const res = await heliusRpc('getSignaturesForAddress', [mint, { limit: 1 }]);
      if(Array.isArray(res) && res.length>0){
        const entry = res[0];
        const s = getSig(entry);
        const bt = entry.blockTime || entry.block_time || entry.blocktime || null;
        FIRST_SIG_CACHE.set(mint, { sig: s || null, blockTime: bt || null, ts: Date.now() });
        return { sig: s || null, blockTime: bt || null };
      }
      FIRST_SIG_CACHE.set(mint, { sig: null, blockTime: null, ts: Date.now() });
      return null;
    }catch(e){
      // cache negative briefly to avoid hammering
      FIRST_SIG_CACHE.set(mint, { sig: null, blockTime: null, ts: Date.now() });
      return null;
    }
  }catch(e){ return null; }
}

// Simple RPC statistics for diagnostics
const RPC_STATS = { calls: 0, errors: 0, rateLimit429: 0, totalLatencyMs: 0 };

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// heliusRpc(method, params, useEnrich=false)
// when useEnrich=true the call uses the second Helius key / URL for enrichment work
async function heliusRpc(method, params){
  // lightweight retry/backoff with jitter for transient failures (including 429)
  const maxRetries = Number(process.env.HELIUS_RPC_MAX_RETRIES || 2);
  for(let attempt=0; attempt<=maxRetries; attempt++){
    RPC_STATS.calls++;
    const start = Date.now();
    try{
      const keyIdx = heliusCallCounter % Math.max(1, _HELIUS_KEYS.length);
      const urlIdx = heliusCallCounter % Math.max(1, HELIUS_RPC_URLS.length);
      heliusCallCounter = (heliusCallCounter + 1) >>> 0;
      const url = HELIUS_RPC_URLS[urlIdx];
      const hdrs = Object.assign({ 'Content-Type': 'application/json' }, _HELIUS_KEYS[keyIdx] ? { 'x-api-key': _HELIUS_KEYS[keyIdx] } : {});
      // make helius timeout configurable (default 5000ms) to favor low-latency responses
      const heliusTimeout = Number(process.env.HELIUS_RPC_TIMEOUT_MS) || 5000;
      const res = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers: hdrs, timeout: heliusTimeout });
      const latency = Date.now() - start; RPC_STATS.totalLatencyMs += latency;
      if(res && res.status === 429) RPC_STATS.rateLimit429++;
      return res.data && (res.data.result || res.data);
    }catch(e){
      const status = e.response && e.response.status;
      if(status === 429) RPC_STATS.rateLimit429++;
      RPC_STATS.errors++;
      // retry on 429 or network errors, otherwise return immediately
      if(attempt < maxRetries && (status === 429 || !status)){
        const base = Number(process.env.HELIUS_RPC_RETRY_BASE_MS) || 150;
        const backoff = base * Math.pow(2, attempt);
        // add jitter
        const jitter = Math.floor(Math.random() * Math.min(100, backoff));
        await sleep(backoff + jitter);
        continue;
      }
      return { __error: (e.response && e.response.statusText) || e.message, status };
    }
  }
}

// Common helius getTransaction options
const HELIUS_TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 };

// Concurrency and retry tuning for getTransaction calls
const TX_CONCURRENCY = Number(process.env.TX_CONCURRENCY) || 10;
const MAX_TX_RETRIES = Number(process.env.MAX_TX_RETRIES) || 2;
const TX_RETRY_BASE_MS = Number(process.env.TX_RETRY_BASE_MS) || 150;

// simple semaphore for limiting concurrent getTransaction calls
let txActive = 0;
const txQueue = [];
function _acquireTxSlot(){
  if(txActive < TX_CONCURRENCY){ txActive++; return Promise.resolve(); }
  return new Promise(resolve=> txQueue.push(resolve));
}
function _releaseTxSlot(){
  txActive = Math.max(0, txActive-1);
  const next = txQueue.shift(); if(next) { txActive++; next(); }
}

// fetchTransaction: uses heliusRpc under the hood but adds concurrency limiting and retries/backoff
async function fetchTransaction(sig){
  await _acquireTxSlot();
  try{
    for(let attempt=0; attempt<=MAX_TX_RETRIES; attempt++){
      const res = await heliusRpc('getTransaction', [sig, HELIUS_TX_OPTS]);
      // heliusRpc returns an object with __error on failure
      if(res && res.__error){
        const status = res.status || null;
        // if rate-limited or transient, retry with backoff
        if(attempt < MAX_TX_RETRIES){
          const backoff = TX_RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(backoff);
          continue;
        }
        return res; // last attempt, return error object
      }
      return res; // success
    }
  }finally{ _releaseTxSlot(); }
}

// Utility: normalize signature field from different shapes
function getSig(entry){
  if(!entry) return null;
  return entry.signature || entry.txHash || entry.sig || entry.txhash || null;
}

// Utility: safely join tx log messages to a lowercase string
function joinTxLogs(tx){
  try{
    const logs = (tx && tx.meta && Array.isArray(tx.meta.logMessages)) ? tx.meta.logMessages : [];
    return logs.join('\n').toLowerCase();
  }catch(e){ return ''; }
}

// Helper: compute canonical age in seconds for a mint using firstBlockTime if available,
// otherwise fall back to transaction block time. Returns null when neither is present.
function getCanonicalAgeSeconds(firstBlockTime, txBlockTime){
  try{
    const now = Date.now();
  if(firstBlockTime) return (now - (Number(firstBlockTime) * 1000)) / 1000;
  if(txBlockTime) return (now - (Number(txBlockTime) * 1000)) / 1000;
  }catch(e){}
  return null;
}

function extractMints(tx){
  const s = new Set();
  try{
    const meta = tx && (tx.meta || (tx.transaction && tx.meta)) || {};
    const arr = [].concat(meta.preTokenBalances||[], meta.postTokenBalances||[]);
    for(const b of arr) if(b && b.mint) s.add(b.mint);
    const inner = meta.innerInstructions || [];
    for(const block of inner){
      const instrs = block && block.instructions || [];
      for(const ins of instrs){
        try{
          const pt = ins && ins.parsed && ins.parsed.info && (ins.parsed.info.mint || ins.parsed.info.postTokenBalances);
          if(pt){ if(Array.isArray(pt)) for(const x of pt) if(x && x.mint) s.add(x.mint); else if(pt) s.add(pt); }
        }catch(e){}
      }
    }
  }catch(e){}
  return Array.from(s);
}

function txKindExplicit(tx){
  try{
    const meta = tx && (tx.meta || (tx.transaction && tx.meta)) || {};
    const logs = Array.isArray(meta.logMessages)? meta.logMessages.join('\n').toLowerCase() : '';
    if(logs.includes('instruction: initializemint') || logs.includes('initialize mint') || logs.includes('instruction: initialize_mint')) return 'initialize';
    if(logs.includes('createpool') || logs.includes('initializepool') || logs.includes('create pool')) return 'pool_creation';
    if(logs.includes('instruction: swap') || logs.includes('\nprogram log: instruction: swap') || logs.includes(' swap ')) return 'swap';
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){
      try{ const t = (ins.parsed && ins.parsed.type) || (ins.type || ''); if(!t) continue; const lt = String(t).toLowerCase(); if(lt.includes('initializemint')||lt.includes('initialize_mint')||lt.includes('initialize mint')) return 'initialize'; if(lt.includes('createpool')||lt.includes('initializepool')||lt.includes('create pool')) return 'pool_creation'; if(lt.includes('swap')) return 'swap'; }catch(e){}
    }
  }catch(e){}
  return null;
}

// Heuristic: confirm that a mint was created/initialized in this transaction
function isMintCreatedInThisTx(tx, mint){
  try{
    if(!tx) return false;
    const logs = joinTxLogs(tx);
    const m = String(mint).toLowerCase();
    // common log markers
    if(logs.includes('instruction: initializemint') || logs.includes('initialize mint') || logs.includes('initialize_mint') || logs.includes('createidempotent')) return true;
    // sometimes log messages include the mint address when created
    if(m && logs.includes(m)) return true;
    // inspect parsed instructions for initialize mint
    const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
    const instrs = (msg && msg.instructions) || [];
    for(const ins of instrs){
      try{
        const t = (ins.parsed && ins.parsed.type) || (ins.type || '');
        if(t && String(t).toLowerCase().includes('initializemint')) return true;
        const info = ins.parsed && ins.parsed.info;
        if(info){
          if(info.mint && String(info.mint).toLowerCase() === m) return true;
          if(info.newAccount && String(info.newAccount).toLowerCase() === m) return true;
        }
      }catch(e){}
    }
  }catch(e){}
  return false;
}

async function mintPreviouslySeen(mint, txBlockTime, currentSig){
  if(!mint) return true;
  try{
    // reduced limit to lower RPC cost; configurable via MINT_SIG_LIMIT
    const sigs = await heliusRpc('getSignaturesForAddress', [mint, { limit: MINT_SIG_LIMIT }]);
    if(!Array.isArray(sigs) || sigs.length===0) return false;
    for(const s of sigs){
      try{ const sig = getSig(s); const bt = s.blockTime||s.block_time||s.blocktime||null; if(sig && sig!==currentSig && bt && txBlockTime && bt < txBlockTime) return true; }catch(e){}
    }
    return false;
  }catch(e){
    // On RPC/network errors return `null` to indicate unknown previous-seen status.
    // Previously we returned `true` which could cause false-negatives during rate-limits.
    try{ console.error('mintPreviouslySeen RPC error for', String(mint).slice(0,8), (e && e.message) || e); }catch(_){}
    return null;
  }
}

async function startSequentialListener(options){
  console.error('Sequential 10s per-program listener starting (daemon mode)');
  const seenMints = new Set();
  let stopped = false;
  process.on('SIGINT', () => { console.error('SIGINT received, stopping listener...'); stopped = true; });
  // Load and cache users once; watch file for changes to avoid reading on every match
  const usersPath = path.join(process.cwd(), 'users.json');
  let users = {};
  const loadUsers = () => {
    try{ const usersRaw = fs.readFileSync(usersPath, 'utf8'); users = usersRaw ? JSON.parse(usersRaw) : {}; }catch(e){ users = {}; }
  };
  loadUsers();
  try{ fs.watchFile(usersPath, { interval: 2000 }, () => { loadUsers(); console.error('users.json reloaded'); }); }catch(e){}
  // require strategy filter once to avoid repeated module resolution cost
  let strategyFilter = null;
  try{ strategyFilter = require('../src/bot/strategy').filterTokensByStrategy; }catch(e){ strategyFilter = null; }
  
  const TARGET_MINTS = Number(process.env.TARGET_MINTS) || 4;
  // track last signature per program to avoid reprocessing the same tx repeatedly
  const lastSigPerProgram = new Map();
  while(!stopped){
    for(const p of PROGRAMS){
      if (stopped) break;
      try{
        const rule = RULES[p] || RULES.default;
        console.error(`[${p}] listening (10s)`);
        const end = Date.now()+10000;
        const seenTxs = new Set();
    while(Date.now()<end){
          if (stopped) break;
          try{
            // Don't skip programs that have empty allow lists; continue but ensure we don't miss explicit initialize events
            if(!rule || !Array.isArray(rule.allow)) break;
      // fetch a small batch of recent signatures to process any new ones
      const sigs = await heliusRpc('getSignaturesForAddress', [p, { limit: SIG_BATCH_LIMIT }]);
            if(!Array.isArray(sigs)||sigs.length===0){ await sleep(250); continue; }
            // process newest first
            let s = sigs[0];
            // find the first unseen signature in the batch
            for(const cand of sigs){
              const candSig = cand && (cand.signature||cand.txHash||cand.sig||cand.txhash);
              if(!candSig) continue;
              if(seenTxs.has(candSig)) continue;
              // also skip if we've already processed this program's latest sig earlier
              if(lastSigPerProgram.get(p) === candSig) { continue; }
              s = cand; break;
            }
            if(!s) { await sleep(POLL_SLEEP_MS); continue; }
            const sig = getSig(s); if(!sig) { await sleep(250); continue; }
            if(seenTxs.has(sig)) { await sleep(POLL_SLEEP_MS); continue; } seenTxs.add(sig);
            lastSigPerProgram.set(p, sig);
            const tx = await fetchTransaction(sig);
            if(!tx || tx.__error) { await sleep(POLL_SLEEP_MS); continue; }
            const kind = txKindExplicit(tx); if(!kind) { await sleep(250); continue; }
            // Always process explicit 'initialize' transactions to avoid missing real mint launches
            if(!(rule.allow.includes(kind) || kind === 'initialize')) { await sleep(250); continue; }
            const mints = extractMints(tx).filter(x=>x && !DENY.has(x)); if(mints.length===0) { await sleep(250); continue; }
            // Fast-path capture-only: write minimal capture immediately and skip enrichment/acceptance heuristics.
            if(CAPTURE_ONLY){
              try{
                const outDir = path.join(process.cwd(), 'out', 'capture_queue');
                try{ fs.mkdirSync(outDir, { recursive: true }); }catch(e){}
                const payload = { time:new Date().toISOString(), program:p, signature:sig, kind: (txKindExplicit(tx) || null), mints: mints.slice(0,10), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                const fileName = Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json';
                const filePath = path.join(outDir, fileName);
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
                console.error('CAPTURED', filePath);
                // update seen set and collector so consumer won't reprocess the same mints
                for(const m of mints) seenMints.add(m);
                for(const m of mints){ if(LATEST_COLLECTED.length < COLLECT_MAX && !LATEST_COLLECTED.includes(m)) LATEST_COLLECTED.push(m); }
                if(LATEST_COLLECTED.length >= COLLECT_MAX){ try{ console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX))); console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() })); if(EXIT_ON_COLLECT){ console.error('Exiting because COLLECT_MAX reached'); process.exit(0); } }catch(e){} }
              }catch(e){}
              await sleep(120);
              continue;
            }
            const fresh = [];
            const txBlock = (s.blockTime||s.block_time||s.blocktime)||(tx&&tx.blockTime)||null;
            for(const m of mints){
              try{
                if(seenMints.has(m)) continue;
                let accept = false;
                // 1) Explicit initialize transactions — accept immediately if the mint is in the tx
                if(kind === 'initialize'){
                  accept = true;
                } else if(kind === 'swap'){
                  // 2) For swaps: accept only if this tx is the mint's first signature AND the firstSig's blockTime
                  //    is close to txBlock (within FIRST_SIG_MATCH_WINDOW_SECS) and within MAX_MINT_AGE_SECS
                  try{
                    const first = await getFirstSignatureCached(m);
                    if(first && first.sig && first.sig === sig){
                      const ft = first.blockTime || null;
                      // compute a canonical age in seconds using firstSig or txBlock
                      const canonicalAge = getCanonicalAgeSeconds(ft, txBlock);
                      if(ft && txBlock){
                        const delta = Math.abs(Number(ft) - Number(txBlock));
                        // Accept when first-signature matches and timing is reasonably close
                        // AND the canonical age is within MAX_MINT_AGE_SECS to avoid accepting old tokens.
                        if(delta <= FIRST_SIG_MATCH_WINDOW_SECS && (canonicalAge !== null && canonicalAge <= MAX_MINT_AGE_SECS)){
                          accept = true;
                        }
                      } else if(canonicalAge !== null && canonicalAge <= MAX_MINT_AGE_SECS){
                        // If only canonicalAge is available (no txBlock), still accept when it's within threshold
                        accept = true;
                      }
                    }
                  }catch(e){ /* ignore */ }
                } else {
                  // 3) For other kinds: only accept if there's a strong created-in-this-tx indicator AND it's fresh
                  try{
                    const createdHere = isMintCreatedInThisTx(tx, m);
                    if(createdHere){
                      // Strong creation indicator -> accept candidate and defer strict age filtering to user strategies.
                      const prev = await mintPreviouslySeen(m, txBlock, sig);
                      // If prev === false -> definitely not seen before -> accept.
                      // If prev === null -> unknown due to RPC error -> treat as unknown and accept to avoid false-negatives.
                      if(prev === false || prev === null) accept = true;
                      else console.error(`REJECT_PREVIOUS_SEEN mint=${m} prevSeen=true sig=${sig}`);
                    }
                  }catch(e){}
                }
                if(accept) fresh.push(m);
              }catch(e){}
            }
            // Print up to 2 newest discovered fresh mints immediately to terminal with color
            // NOTE: to avoid noisy stdout we only emit these quick candidate arrays when DEBUG_WS is set.
            try{
              if(Array.isArray(fresh) && fresh.length>0){
                const latest = fresh.slice(0,2);
                if (process.env.DEBUG_WS) {
                  // debug mode: print to stdout for quick inspection
                  try{ console.log(JSON.stringify(latest)); }catch(e){ console.log(String(latest)); }
                } else {
                  // non-debug: suppress stdout noise and write a compact message to stderr
                  try{ console.error('fresh-candidates suppressed (use DEBUG_WS=1 to enable):', JSON.stringify(latest)); }catch(e){}
                }
              }
            }catch(e){}
            if(fresh.length===0) { await sleep(250); continue; }
            if(kind==='swap'){
              // Tightened rule: require an explicit parsed instruction reference
              // (info.mint / info.source / info.destination) to match a fresh mint.
              try{
                const msg = tx && (tx.transaction && tx.transaction.message) || tx.transaction || {};
                const instrs = (msg && msg.instructions) || [];
                let referencesFresh = false;
                for(const ins of instrs){
                  try{
                    const info = ins.parsed && ins.parsed.info;
                    if(info){
                      if(info.mint && fresh.includes(info.mint)) referencesFresh = true;
                      if(info.source && fresh.includes(info.source)) referencesFresh = true;
                      if(info.destination && fresh.includes(info.destination)) referencesFresh = true;
                    }
                  }catch(e){}
                }
        if(!referencesFresh){ await sleep(POLL_SLEEP_MS); continue; }
              }catch(e){}
            }
            for(const m of fresh) seenMints.add(m);
            // Emit global event for listeners (no DEX enrichment)
            const globalEvent = { time:new Date().toISOString(), program:p, signature:sig, kind: kind, freshMints:fresh.slice(0,5), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
            // By default route global events to stderr to avoid polluting stdout (which is reserved
            // for confirmed initialize collector events). Set DEBUG_WS=1 to print full JSON to stdout.
            if (process.env.DEBUG_WS) {
              console.log(JSON.stringify(globalEvent));
            } else {
              try{ console.error('programEvent (suppressed JSON):', JSON.stringify({ program: p, signature: sig, kind: kind, freshCount: (fresh && fresh.length) || 0 })); }catch(e){}
            }
            // If capture-only mode is enabled, write a tiny capture file and skip enrichment
            if(CAPTURE_ONLY){
              try{
                const outDir = path.join(process.cwd(), 'out', 'capture_queue');
                try{ fs.mkdirSync(outDir, { recursive: true }); }catch(e){}
                const payload = { time:new Date().toISOString(), program:p, signature:sig, kind:kind, fresh:fresh.slice(0,10), sampleLogs:(tx.meta&&tx.meta.logMessages||[]).slice(0,6) };
                const fileName = Date.now() + '-' + Math.random().toString(36).slice(2,8) + '.json';
                const filePath = path.join(outDir, fileName);
                fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
                console.error('CAPTURED', filePath);
              }catch(e){}
              // still update collector and seen set but skip heavy enrichment
              try{ for(const m of fresh) seenMints.add(m); }catch(e){}
              await sleep(120);
              continue;
            }
            // Collector: push accepted fresh mints (first up-to COLLECT_MAX unique entries)
            try{
              for(const m of fresh){
                if(LATEST_COLLECTED.length >= COLLECT_MAX) break;
                if(!LATEST_COLLECTED.includes(m)) LATEST_COLLECTED.push(m);
              }
              if(LATEST_COLLECTED.length >= COLLECT_MAX){
                try{
                  console.error('COLLECTED_FINAL', JSON.stringify(LATEST_COLLECTED.slice(0, COLLECT_MAX)));
                  console.log(JSON.stringify({ collected: LATEST_COLLECTED.slice(0, COLLECT_MAX), time: new Date().toISOString() }));
                }catch(e){}
                if(EXIT_ON_COLLECT){
                  try{ console.error('Exiting because COLLECT_MAX reached'); }catch(e){}
                  process.exit(0);
                }
              }
            }catch(e){}
            // emit program-level event
            try{ notifier.emit('programEvent', globalEvent); }catch(e){}
            // Also evaluate per-user strategies (if any) and emit per-user matches
            try{
              const strategyFilterLocal = strategyFilter; // cached above
              const usersLocal = users || {};
              // Build token objects from fresh mints for filtering
              // Lightweight on-chain enrichment: fetch the first signature for each mint to derive a first-tx timestamp (cheap, 1 RPC per mint)
                const candidateTokens = await Promise.all(fresh.map(async (m) => {
                const mintAddr = m;
                // include listener source metadata so strategy filters can preserve/inspect realtime origin
                const tok = { address: mintAddr, tokenAddress: mintAddr, mint: mintAddr, sourceProgram: p, sourceSignature: sig, sampleLogs: (tx.meta&&tx.meta.logMessages||[]).slice(0,10), sourceCandidates: true };
                try{
                  // Lightweight on-chain first-signature probe to compute freshness only
                  try{
                    const sigs = await heliusRpc('getSignaturesForAddress', [mintAddr, { limit: 1 }]);
                    if (Array.isArray(sigs) && sigs.length > 0) {
                      const s0 = sigs[0];
                      const bt = s0.blockTime || s0.block_time || s0.blocktime || null;
                      if (bt) {
                        try { tok.freshnessDetails = { firstTxMs: Number(bt) * 1000 }; } catch(e){}
                        try { tok._canonicalAgeSeconds = getCanonicalAgeSeconds(bt, null); } catch(e){}
                      }
                    }
                  }catch(e){}
                }catch(e){}
                return tok;
              }));
        for(const uid of Object.keys(usersLocal || {})){
                try{
          const user = usersLocal[uid];
                  if(!user || !user.strategy || user.strategy.enabled === false) continue;
          // run the filter (allow enrichment inside strategy filter for accuracy)
      if(!strategyFilterLocal) continue;
          // If the user's numeric strategy fields are all zero/undefined, treat this user
          // as a listener-only user: accept listener-provided candidateTokens directly
          // (no conditions, no enrichment). Otherwise run the normal strategy filter.
          let matched = [];
          try{
            const numericKeys = ['minMarketCap','minLiquidity','minVolume','minAge'];
            const hasNumericConstraint = numericKeys.some(k => {
              const v = user.strategy && user.strategy[k];
              return v !== undefined && v !== null && Number(v) > 0;
            });
            if(!hasNumericConstraint){
              // listener-only: accept raw listener tokens as matches (limit to maxTrades)
              const maxTrades = Number(user.strategy && user.strategy.maxTrades ? user.strategy.maxTrades : 3) || 3;
              matched = (Array.isArray(candidateTokens) ? candidateTokens.slice(0, maxTrades) : []);
              try{ console.error(`MATCH (listener-bypass) user=${uid} matched=${matched.map(t=>t.address||t.tokenAddress||t.mint).slice(0,5)}`); }catch(e){}
            } else {
              // default: run the robust strategy filter (may enrich)
              // DEBUG: print per-candidate diagnostics so we can see why tokens are rejected
              try{
                const tu = require('../src/utils/tokenUtils');
                for(const tok of candidateTokens){
                  try{
                    const pre = tu.autoFilterTokensVerbose([tok], user.strategy);
                    const preCount = Array.isArray(pre) ? (pre.length) : (pre && pre.passed ? (pre.passed.length||0) : 0);
                    const willPass = await strategyFilterLocal([tok], user.strategy, { preserveSources: true }).then(r=> Array.isArray(r) && r.length>0).catch(()=>false);
                    try{ console.error(`STRATEGY_DEBUG user=${uid} token=${tok && (tok.tokenAddress||tok.address||tok.mint)} preCandidates=${preCount} pass=${willPass} age=${tok && (tok._canonicalAgeSeconds || (tok.freshnessDetails && tok.freshnessDetails.firstTxMs)) || 'n/a'} sampleLogs=${(tok && tok.sampleLogs? (tok.sampleLogs||[]).slice(0,3).join('|') : '')}`); }catch(e){}
                  }catch(e){}
                }
              }catch(e){}
              matched = await strategyFilterLocal(candidateTokens, user.strategy, { preserveSources: true }).catch(() => []);
            }
          }catch(e){ matched = []; }
                  if(Array.isArray(matched) && matched.length > 0){
                    const matchAddrs = matched.map(t => t.address || t.tokenAddress || t.mint).slice(0,5);
                    const userEvent = { time:new Date().toISOString(), program:p, signature:sig, user: uid, matched: matchAddrs, kind: kind, candidateTokens: candidateTokens.slice(0,10) };
                    // Detailed log for matches
                    console.error('MATCH', JSON.stringify(userEvent));
                    // Build a standardized per-user collector-like payload:
                    // 1) freshMints: array of matched addresses (for the quick payload line)
                    // 2) userCollectorEvent: detailed object similar to collectorEvent used by collectFreshMints
                    const freshMintsArr = matchAddrs.slice(0, 10);
                    const userCollectorEvent = {
                      time: userEvent.time,
                      program: p,
                      signature: sig,
                      kind: kind,
                      freshMints: freshMintsArr,
                      matched: matchAddrs,
                      user: uid,
                      candidateTokens: userEvent.candidateTokens
                    };
                    // Build a Telegram-ready payload (contains both quick array and detailed event)
                    let payload = { freshMints: freshMintsArr, event: userCollectorEvent, tokens: userEvent.candidateTokens };
                    // Add top-level convenience fields expected by existing Telegram handler
                    payload.user = uid;
                    payload.time = userEvent.time;
                    payload.program = p;
                    payload.signature = sig;
                    payload.matched = matchAddrs;
                    try{
                      if(_tokenUtils && typeof _tokenUtils.buildTokenMessage === 'function'){
                        // build a preview for the first matched token to include rich HTML and keyboard
                        const firstAddr = (userEvent.candidateTokens && userEvent.candidateTokens[0]) || null;
                        if(firstAddr){
                          const tokenObj = firstAddr; // already a lightweight token object
                          const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';
                          const pairAddress = tokenObj.pairAddress || tokenObj.tokenAddress || tokenObj.address || tokenObj.mint || '';
                          try{
                            const built = _tokenUtils.buildTokenMessage(tokenObj, botUsername, pairAddress, uid);
                            if(built && built.msg){ payload.html = built.msg; payload.inlineKeyboard = built.inlineKeyboard || (built.inlineKeyboard ? built.inlineKeyboard : built.inlineKeyboard); }
                          }catch(e){}
                        }
                      }
                    }catch(e){}
                    // Push into in-memory per-user queue (temporary background store)
                    try{
                      const q = global.__inMemoryNotifQueues;
                      if(q){
                        const key = String(uid);
                        if(!q.has(key)) q.set(key, []);
                        const arr = q.get(key) || [];
                        // push standardized payload as JSON string for consumers that read the list
                        arr.unshift(payload);
                        // trim
                        if(arr.length > INMEM_NOTIF_MAX) arr.length = INMEM_NOTIF_MAX;
                        q.set(key, arr);
                      }
                    }catch(e){}
                    // Emit in-process notification for same-process bots
                    try{ notifier.emit('notification', payload); }catch(e){}
                    // Optional: if Redis configured, LPUSH for cross-process delivery
                    try{
                      const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_URI || null;
                      if(REDIS_URL){
                        try{
                          const { createClient } = require('redis');
                          const rc = createClient({ url: REDIS_URL });
                          rc.on && rc.on('error', ()=>{});
                          await rc.connect().catch(()=>{});
                          const listKey = `listener:notifications:${uid}`;
                          // push freshMints array line and the detailed event as two entries for parity with stdout
                          try{ await rc.lPush(listKey, JSON.stringify(payload)).catch(()=>{}); }catch(e){}
                          const maxlen = Number(process.env.NOTIF_REDIS_MAX_PER_USER || 50);
                          try{ if(maxlen>0) await rc.lTrim(listKey, 0, maxlen-1).catch(()=>{}); }catch(e){}
                          try{ await rc.disconnect().catch(()=>{}); }catch(e){}
                        }catch(e){}
                      }
                      // Optional auto-execution hook: when explicitly enabled via env var, trigger
                      // per-user auto execution (buy) for matched tokens. Disabled by default to
                      // avoid accidental trading. Set ENABLE_AUTO_EXEC_FROM_LISTENER=true to enable.
            try{
              const AUTO_EXEC_ENABLED = (process.env.ENABLE_AUTO_EXEC_FROM_LISTENER === 'true');
              const AUTO_EXEC_CONFIRM_USER_IDS = (process.env.AUTO_EXEC_CONFIRM_USER_IDS || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
              if(AUTO_EXEC_ENABLED){
                          try{
                            const shouldAuto = user && user.strategy && user.strategy.autoBuy !== false && Number(user.strategy && user.strategy.buyAmount) > 0;
                            const hasCredentials = user && (user.wallet || user.secret);
                            // require user to be explicitly confirmed in AUTO_EXEC_CONFIRM_USER_IDS
                            const userConfirmed = AUTO_EXEC_CONFIRM_USER_IDS.length === 0 ? false : AUTO_EXEC_CONFIRM_USER_IDS.includes(String(uid));
                            if(shouldAuto && hasCredentials && userConfirmed){
                              try{
                                const autoExecMod = require('../src/autoStrategyExecutor');
                                const autoExec = autoExecMod && (autoExecMod.autoExecuteStrategyForUser || autoExecMod.default || null);
                                if(typeof autoExec === 'function'){
                                  // run in background, do not block main listener loop
                                  const execTokens = Array.isArray(matched) ? matched.slice(0, Number(user.strategy && user.strategy.maxTrades ? user.strategy.maxTrades : 3) || 1) : [];
                                  (async () => {
                                    try{ await autoExec(user, execTokens, 'buy'); }catch(e){ try{ console.error('[listener:autoExec] error', (e && e.message) || e); }catch(_){} }
                                  })();
                                }
                              }catch(e){ /* ignore auto-exec errors */ }
                            } else if(shouldAuto && hasCredentials && !userConfirmed){
                              try{ console.error(`[listener:autoExec] user=${uid} not in AUTO_EXEC_CONFIRM_USER_IDS - skipping auto-exec`); }catch(e){}
                            }
                          }catch(e){}
                        }
                      }catch(e){}
                    }catch(e){}
                  }
                }catch(e){ /* per-user errors shouldn't break main loop */ }
              }
            }catch(e){}
          }catch(e){ }
          await sleep(120);
        }
        console.error(`[${p}] done`);
      }catch(e){ console.error(`[${p}] err ${String(e)}`); }
    }
    // Print RPC stats summary per full cycle
    try{
      const avg = RPC_STATS.calls ? Math.round(RPC_STATS.totalLatencyMs / RPC_STATS.calls) : 0;
      console.error('RPC_STATS', JSON.stringify({ calls: RPC_STATS.calls, errors: RPC_STATS.errors, rateLimit429: RPC_STATS.rateLimit429, avgLatencyMs: avg }));
    }catch(e){}
    // short delay between cycles to avoid tight looping
    try { await sleep(2000); } catch (e) { }
  }
  console.error('Sequential 10s per-program listener stopped');
}

module.exports.startSequentialListener = startSequentialListener;
// Lightweight one-shot collector: run the minimal discovery loop until we collect
// `maxCollect` fresh mints or `timeoutMs` elapses. Returns an array of mint addresses.
async function collectFreshMints({ maxCollect = 3, timeoutMs = 20000, maxAgeSec = undefined, strictOverride = undefined } = {}){
  const collected = [];
  const seenMintsLocal = new Set();
  const stopAt = Date.now() + (Number(timeoutMs) || 20000);
  try{
    for(const p of PROGRAMS){
      if(Date.now() > stopAt) break;
      try{
        const sigs = await heliusRpc('getSignaturesForAddress', [p, { limit: SIG_BATCH_LIMIT }]);
        if(!Array.isArray(sigs) || sigs.length===0) continue;
        for(const s of sigs){
          if(Date.now() > stopAt) break;
          const sig = getSig(s); if(!sig) continue;
          const tx = await fetchTransaction(sig);
          if(!tx || tx.__error) continue;
          const kind = txKindExplicit(tx); if(!kind) continue;
          // For the strict collector used for explicit mint detection, only consider explicit 'initialize' transactions.
          if (kind !== 'initialize') continue;
          const rule = RULES[p] || RULES.default;
          if(!(rule.allow.includes(kind) || kind === 'initialize')) continue;
          const mints = extractMints(tx).filter(x=>x && !DENY.has(x)); if(mints.length===0) continue;
          const txBlock = (s.blockTime||s.block_time||s.blocktime)||(tx&&tx.blockTime)||null;
            for(const m of mints){
            if(collected.length >= maxCollect) break;
            if(seenMintsLocal.has(m)) continue;
            let accept = false;
            // allowAge is used in multiple branches below; compute once per-mint so it's in scope
              // If caller provided maxAgeSec, enforce it; otherwise do not enforce a global age cutoff
              const allowAge = (maxAgeSec !== undefined && maxAgeSec !== null) ? Number(maxAgeSec) : null;
            // Only consider explicit initialize-created mints: require strong create-in-this-tx indicator
            // This avoids including tokens that only appear in swap flows or as references.
            try{
              const createdHere = isMintCreatedInThisTx(tx, m);
              if(!createdHere) {
                // skip non-created-in-this-tx mints even if the tx kind is initialize
                continue;
              }
              // require not previously seen
              const prevInit = await mintPreviouslySeen(m, txBlock, sig);
              // Accept when not previously seen (false) or when unknown (null) to avoid dropping true positives
              // during transient RPC failures/rate-limits. Only reject when prevInit === true.
              if(prevInit === false || prevInit === null) accept = true;
            }catch(e){}
            if(accept){
              try{
                // compute lightweight on-chain age fields for downstream consumers
                const firstCached = await getFirstSignatureCached(m).catch(()=>null);
                const ft = firstCached && firstCached.blockTime ? firstCached.blockTime : null;
                const ageSec = getCanonicalAgeSeconds(ft, txBlock);
                // Emit structured collector event instead of freeform debug line so consumers
                // can easily parse initialize events and fresh mints.
                // Previous debug line: COLLECT_DEBUG accept program=... kind=... mint=...
                const collectorEvent = {
                  time: new Date().toISOString(),
                  program: p,
                  signature: sig,
                  kind: 'initialize',
                  freshMints: [m],
                  ageSeconds: ageSec,
                  firstBlock: ft,
                  txBlock: txBlock,
                };
                try{
                  // Print the fresh mints array line first for the live-style output
                  try{ console.log(JSON.stringify(collectorEvent.freshMints)); }catch(e){}
                  console.log(JSON.stringify(collectorEvent));
                  // If running as a forked child, send via IPC so parent can receive structured events
                  try{ if(typeof process !== 'undefined' && typeof process.send === 'function') process.send && process.send(collectorEvent); }catch(e){}
                }catch(e){}

                const tok = {
                  tokenAddress: m,
                  address: m,
                  mint: m,
                  firstBlockTime: ft ? Number(ft) * 1000 : null, // ms epoch when available
                  _canonicalAgeSeconds: ageSec,
                  sourceProgram: p,
                  sourceSignature: sig,
                  kind: kind,
                  txBlock: txBlock,
                  sampleLogs: (tx.meta && tx.meta.logMessages || []).slice(0,6),
                  __listenerCollected: true,
                };
                collected.push(tok);
                seenMintsLocal.add(m);
              }catch(e){
                // fallback: still push a simple string if object creation fails
                try{ collected.push(m); seenMintsLocal.add(m); }catch(_){}
              }
            }
          }
          if(collected.length >= maxCollect) break;
        }
      }catch(e){}
      if(collected.length >= maxCollect) break;
    }
  }catch(e){}
  return Array.from(new Set(collected)).slice(0, maxCollect);
}
module.exports.collectFreshMints = collectFreshMints;
// If script is executed directly, run immediately (CLI usage preserved)
if (require.main === module) {
  startSequentialListener().catch(e => { console.error('Listener failed:', e && e.message || e); process.exit(1); });
}