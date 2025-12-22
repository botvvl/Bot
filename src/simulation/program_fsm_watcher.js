#!/usr/bin/env node
/**
 * Program FSM Watcher
 * - Subscribes to sniper.notifier program events
 * - Maintains per-mint bitmask states based on observed account/log clues
 * - Triggers when a mint's mask reaches READY_MASK within the same slot
 */
require('dotenv').config();
const sniper = require('../../sniper.js');
const EventEmitter = require('events');
const sim = require('./sniper_simulator');
const { struct, u32, u8 } = require('@solana/buffer-layout');
const { bool, publicKey, u64 } = require('@solana/buffer-layout-utils');
const { PublicKey } = require('@solana/web3.js');
let connection = null;
let cfg = null;
try{
  cfg = require('../config');
  connection = cfg && cfg.connection;
}catch(_e){
  cfg = null;
  connection = null;
}

// Bits: 0=mint_exists,1=authority_ok,2=pool_exists,3=pool_initialized
// Added bits:
// 4=transferable (decimals valid / ATA present / jupiter tradable)
// 5=slot-sequence confidence (observed N-1 -> N account transition)
const BIT_MINT_EXISTS = 1<<0;
const BIT_AUTH_OK = 1<<1;
const BIT_POOL_EXISTS = 1<<2;
const BIT_POOL_INIT = 1<<3;
const BIT_TRANSFERABLE = 1<<4;
const BIT_SLOT_SEQ = 1<<5;
const CORE_MASK = BIT_MINT_EXISTS|BIT_AUTH_OK|BIT_POOL_EXISTS|BIT_POOL_INIT;
const READY_MASK = CORE_MASK; // legacy name

// scoring weights (sum to 1.0)
const WEIGHTS = {
  [BIT_MINT_EXISTS]: 0.20,
  [BIT_AUTH_OK]: 0.20,
  [BIT_POOL_EXISTS]: 0.15,
  [BIT_POOL_INIT]: 0.15,
  [BIT_TRANSFERABLE]: 0.20,
  [BIT_SLOT_SEQ]: 0.10,
};
const SCORE_THRESHOLD = (cfg && typeof cfg.READY_SCORE_THRESHOLD !== 'undefined') ? Number(cfg.READY_SCORE_THRESHOLD) : Number(process.env.READY_SCORE_THRESHOLD || 0.80);

// Mint layout (same as src/raydium/types/mint.ts)
const MintLayout = struct([
  u32('mintAuthorityOption'),
  publicKey('mintAuthority'),
  u64('supply'),
  u8('decimals'),
  bool('isInitialized'),
  u32('freezeAuthorityOption'),
  publicKey('freezeAuthority'),
]);

const { createJupiterApiClient } = (() => { try{ return require('@jup-ag/api'); }catch(e){ return {}; } })();

// Probe caches and settings
const PROBE_TTL_MS = (cfg && typeof cfg.PROBE_TTL_MS !== 'undefined') ? Number(cfg.PROBE_TTL_MS) : Number(process.env.PROBE_TTL_MS || 10000);
// reduce default retries and backoff to favor low-latency final reprobes
const PROBE_RETRY = (cfg && typeof cfg.PROBE_RETRY !== 'undefined') ? Number(cfg.PROBE_RETRY) : Number(process.env.PROBE_RETRY || 1);
const PROBE_BACKOFF_BASE_MS = (cfg && typeof cfg.PROBE_BACKOFF_BASE_MS !== 'undefined') ? Number(cfg.PROBE_BACKOFF_BASE_MS) : Number(process.env.PROBE_BACKOFF_BASE_MS || 10);
const accountCache = new Map(); // mint -> { ts, val }
const tokenLargestCache = new Map();
const jupiterCache = new Map();

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function withRetries(fn){
  let lastErr = null;
  for(let attempt=0; attempt<PROBE_RETRY; attempt++){
    try{ return await fn(); }catch(e){ lastErr = e; const backoff = PROBE_BACKOFF_BASE_MS * Math.pow(2, attempt); await sleep(backoff); }
  }
  throw lastErr;
}

async function probeGetAccountInfo(pk){
  try{
    const cached = accountCache.get(pk);
    if(cached && (Date.now() - cached.ts) < PROBE_TTL_MS) return cached.val;
    const val = await withRetries(async ()=> await connection.getAccountInfo(new PublicKey(pk)).catch(()=>null));
    accountCache.set(pk, { ts: Date.now(), val });
    return val;
  }catch(e){ return null; }
}

async function probeTokenLargestAccounts(pk){
  try{
    const cached = tokenLargestCache.get(pk);
    if(cached && (Date.now() - cached.ts) < PROBE_TTL_MS) return cached.val;
    const val = await withRetries(async ()=> await connection.getTokenLargestAccounts(new PublicKey(pk)).catch(()=>null));
    tokenLargestCache.set(pk, { ts: Date.now(), val });
    return val;
  }catch(e){ return null; }
}

async function probeJupiterSmallQuote(mint){
  try{
    const cached = jupiterCache.get(mint);
    if(cached && (Date.now() - cached.ts) < PROBE_TTL_MS) return cached.val;
    if(!createJupiterApiClient) return null;
    const client = createJupiterApiClient();
    const inputCandidates = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ];
    let best = null;
    for(const inputMint of inputCandidates){
      try{
        const q = await withRetries(async ()=> await client.quoteGet({ inputMint, outputMint: mint, amount: Math.floor(0.1 * 1e9), slippageBps: 100 }).catch(()=>null));
        if(!q) continue;
        // determine a numeric score: prefer lower priceImpactPct (if available) else larger outAmount
        let pi = null;
        try{ pi = Number(q.priceImpactPct || q.price_impact_pct || (q.routesInfos && q.routesInfos[0] && q.routesInfos[0].priceImpactPct) || (q.routesInfos && q.routesInfos[0] && q.routesInfos[0].priceImpact) || null); }catch(_){ pi = null; }
        const outAmt = Number(q.outAmount || q.out_amount || (q.routesInfos && q.routesInfos[0] && q.routesInfos[0].outAmount) || 0);
        const score = (pi === null) ? (1e12 / Math.max(1, outAmt)) : pi; // lower better
        if(!best || (score < best.score)) best = { q, inputMint, score, pi, outAmt };
      }catch(_e){ }
    }
    jupiterCache.set(mint, { ts: Date.now(), val: best });
    return best;
  }catch(e){ return null; }
}

// helper: promise with hard timeout (ms)
function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_, rej)=> setTimeout(()=> rej(new Error('timeout')), ms))
  ]);
}

class ProgramFSM extends EventEmitter {
  constructor(opts={}){
    super();
    this.states = new Map(); // mint -> { mask, slot, lastSeenTs }
    this.programs = opts.programs || []; // optional filter of program IDs
    this._onEvent = this._onEvent.bind(this);
    this._logSubs = [];
    if(sniper && sniper.notifier && typeof sniper.notifier.on === 'function'){
      sniper.notifier.on('programEvent', this._onEvent);
      sniper.notifier.on('notification', this._onEvent);
    }

    // If we have a live connection, also attach fast `onLogs` subscriptions to catch program invocations earlier.
    try{
      if(connection && typeof connection.onLogs === 'function' && Array.isArray(this.programs) && this.programs.length>0){
        for(const p of this.programs){
          try{
            const pk = new PublicKey(p);
            const subId = connection.onLogs(pk, (logs, ctx) => {
              // When logs appear, immediately poll the collector to find fresh mints
              (async ()=>{
                try{
                  const collected = await (sniper.collectFreshMints ? sniper.collectFreshMints({ maxCollect: 6, timeoutMs: 600 }) : Promise.resolve(null));
                  if(Array.isArray(collected)){
                    for(const c of collected){
                      if(c && (c.sourceProgram === p || c.program === p || c.source === p)){
                        // forward to the same handler used by notifier
                        try{ this._onEvent(c); }catch(_e){}
                        return;
                      }
                    }
                  }
                }catch(_e){}
              })();
            }, 'confirmed');
            this._logSubs.push(subId);
          }catch(_e){}
        }
      }
    }catch(_e){}
  }

  _now(){ return Date.now(); }

  _ensure(mint, slot){
    if(!this.states.has(mint)) this.states.set(mint, { mask:0, slot: slot || null, lastSeenTs: this._now() });
    const s = this.states.get(mint);
    if(slot) s.slot = slot;
    s.lastSeenTs = this._now();
    return s;
  }

  async _probeMintAndUpdate(m, s){
    if(!connection) return;
    try{
      const pk = new PublicKey(m);
      const ai = await probeGetAccountInfo(m);
      if(!ai){
        // no account yet
        return;
      }
      // bit 0: mint exists
      s.mask |= BIT_MINT_EXISTS;

      // try parse mint layout
      try{
        const data = Buffer.isBuffer(ai.data) ? ai.data : Buffer.from(ai.data);
        const raw = MintLayout.decode(data);
        if(raw){
          if(Number(raw.mintAuthorityOption) === 1) s.mask |= BIT_AUTH_OK;
          if(Boolean(raw.isInitialized)) s.mask |= BIT_POOL_INIT;
          // transferable heuristic: decimals present and supply > 0
          try{ if(Number(raw.decimals) >= 0) s.mask |= BIT_TRANSFERABLE; }catch(_e){}
        }
      }catch(_e){
        // parsing failed, ignore
      }

      // bit2: pool exists -> check token largest accounts (any token accounts for this mint)
      try{
        const la = await probeTokenLargestAccounts(m);
        if(la && Array.isArray(la.value) && la.value.length>0) s.mask |= BIT_POOL_EXISTS;
        // if any account has amount>0 then pool init
        try{ if(la && Array.isArray(la.value)){ for(const v of la.value){ const amt = v && v.uiAmount ? v.uiAmount : (v && v.amount ? Number(v.amount) : 0); if(amt && Number(amt) > 0) s.mask |= BIT_POOL_INIT; } } }catch(_e){}
      }catch(_e){}

      // If not yet transferable, try lightweight Jupiter quote to confirm tradability
      try{
        if(!(s.mask & BIT_TRANSFERABLE)){
          const jq = await probeJupiterSmallQuote(m);
          if(jq && (jq.routePlan || jq.outAmount || (jq.routesInfos && jq.routesInfos.length>0))) s.mask |= BIT_TRANSFERABLE;
        }
      }catch(_e){}

      // maintain per-mint history for slot-sequence detection
      try{
        if(!this._mintHistory) this._mintHistory = new Map();
        const h = this._mintHistory.get(m) || [];
        h.push({ slot: s.slot, mask: s.mask, ts: Date.now() });
        if(h.length > 6) h.shift();
        this._mintHistory.set(m, h);
        // detect N-1 -> N transition
        if(h.length >= 2){
          const prev = h[h.length-2];
          const curr = h[h.length-1];
          if(prev && prev.slot && curr && curr.slot && Number(curr.slot) === Number(prev.slot) + 1){
            const prevMask = prev.mask || 0;
            const currMask = curr.mask || 0;
            if((prevMask & BIT_MINT_EXISTS) && (prevMask & BIT_AUTH_OK) && !(prevMask & BIT_POOL_INIT) && (currMask & BIT_POOL_INIT)){
              s.mask |= BIT_SLOT_SEQ;
            }
          }
        }
      }catch(_e){}
    }catch(e){
      console.error('[FSM] probe error', e && e.message ? e.message : e);
    }
  }

  _onEvent(ev){
    try{
      const program = ev && ev.program;
      if(this.programs.length>0 && !this.programs.includes(program)) return; // optional filter
      const slot = ev && (ev.slot || ev.blockSlot || ev.txBlock || ev.firstBlock || null);
      const fresh = Array.isArray(ev.freshMints) ? ev.freshMints : [];
      for(const m of fresh){
        const s = this._ensure(m, slot);
        // perform deterministic RPC probes asynchronously
        (async ()=>{
          await this._probeMintAndUpdate(m, s);
          // emit state update
          this.emit('state', { mint: m, mask: s.mask, slot: s.slot, lastSeen: s.lastSeenTs });
          // if ready and slot matches current event slot -> perform final reprobe then trigger immediate
          if((s.mask & READY_MASK) === READY_MASK && s.slot && slot && Number(s.slot) === Number(slot)){
            try{
              // final quick reprobe for atomicity (reduce race conditions).
              // Run probes in parallel to minimize latency (target <=20ms).
              try{
                const t0 = Date.now();
                // limit each probe to a short timeout to hit micro-latency targets
                const perProbeMs = (cfg && typeof cfg.FINAL_REPROBE_PER_PROBE_MS !== 'undefined') ? Number(cfg.FINAL_REPROBE_PER_PROBE_MS) : Number(process.env.FINAL_REPROBE_PER_PROBE_MS || 12);
                const jupiterMs = (cfg && typeof cfg.FINAL_REPROBE_JUPITER_MS !== 'undefined') ? Number(cfg.FINAL_REPROBE_JUPITER_MS) : Number(process.env.FINAL_REPROBE_JUPITER_MS || 18);
                const [finalAi, finalLa, jq] = await Promise.all([
                  withTimeout(probeGetAccountInfo(m).catch(()=>null), perProbeMs).catch(()=>null),
                  withTimeout(probeTokenLargestAccounts(m).catch(()=>null), perProbeMs).catch(()=>null),
                  withTimeout(probeJupiterSmallQuote(m).catch(()=>null), jupiterMs).catch(()=>null),
                ]);
                const t1 = Date.now();
                try{ console.error('[FSM] final reprobe latency ms:', (t1 - t0)); }catch(_e){}

                if(finalAi){
                  try{
                    const data = Buffer.isBuffer(finalAi.data) ? finalAi.data : Buffer.from(finalAi.data);
                    const raw = MintLayout.decode(data);
                    if(raw){ if(Number(raw.mintAuthorityOption) === 1) s.mask |= BIT_AUTH_OK; if(Boolean(raw.isInitialized)) s.mask |= BIT_POOL_INIT; }
                  }catch(_e){}
                }

                if(finalLa && Array.isArray(finalLa.value) && finalLa.value.length>0) s.mask |= BIT_POOL_EXISTS;
                try{ if(finalLa && Array.isArray(finalLa.value)){ for(const v of finalLa.value){ const amt = v && v.uiAmount ? v.uiAmount : (v && v.amount ? Number(v.amount) : 0); if(amt && Number(amt) > 0) s.mask |= BIT_POOL_INIT; } } }catch(_e){}

                if(!(s.mask & BIT_TRANSFERABLE) && jq && (jq.routePlan || jq.outAmount || (jq.routesInfos && jq.routesInfos.length>0))) s.mask |= BIT_TRANSFERABLE;
              }catch(_e){}

              // signature-based slot-sequence check (final reprobe) — run ASAP to boost confidence
              try{
                if(connection && s.slot){
                  try{
                    const sigs = await connection.getSignaturesForAddress(new PublicKey(m), { limit: 6 });
                    if(Array.isArray(sigs) && sigs.length>0){
                      for(const e of sigs){
                        const sslot = e && (e.slot || e.slotIndex || null);
                        if(sslot && Number(sslot) === Number(s.slot) - 1){ s.mask |= BIT_SLOT_SEQ; break; }
                      }
                    }
                  }catch(_e){}
                }
              }catch(_e){}

              // require transferable as a hard guard
              const hasTransferable = Boolean(s.mask & BIT_TRANSFERABLE);
              const coreOk = ((s.mask & CORE_MASK) === CORE_MASK);
              // compute score
              let score = 0;
              for(const [bit, w] of Object.entries(WEIGHTS)){
                try{ if(s.mask & Number(bit)) score += Number(w); }catch(_e){}
              }

              // ready if transferable present AND (core bits all present OR score >= threshold)
                      if(hasTransferable && (coreOk || score >= SCORE_THRESHOLD)){
                        const trig = { mint: m, slot: s.slot, mask: s.mask, reason: 'ready_mask_matched_in_slot', probes: { simulated: true } };
                        this.emit('trigger', trig);
                        console.error('[FSM] SIMULATED trigger for', m, 'mask=', s.mask.toString(2).padStart(8,'0'));
                        // Also emit a standardized notification via sniper.notifier so in-process Telegram bot picks it up.
                        try{
                          if(sniper && sniper.notifier && typeof sniper.notifier.emit === 'function'){
                            const adminUser = (require('../config') && require('../config').NOTIFY_ADMIN_ID) ? require('../config').NOTIFY_ADMIN_ID : (process.env.NOTIFY_ADMIN_ID || null);
                            const payload = {
                              user: adminUser || (process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',')[0] : null),
                              freshMints: [m],
                              tokens: [ { tokenAddress: m, mint: m } ],
                              program: this.programs && this.programs.length>0 ? this.programs[0] : null,
                              time: new Date().toISOString(),
                              signature: null,
                              reason: 'program_fsm_ready'
                            };
                            try{ sniper.notifier.emit('notification', payload); }catch(_e){}
                          }
                        }catch(_e){}
                try{
                  const st = { token: m, liquidity_usd: 12000, pool_initialized: true, is_transferable: !!(s.mask & BIT_TRANSFERABLE), mint_authority: !!(s.mask & BIT_AUTH_OK), freeze_authority: false, update_authority: false };
                  const execution = sim.pre_slot_analysis(st);
                  try{ execution.trigger(); console.error('⚡ EXECUTION TRIGGERED (simulation)'); }catch(e){ console.error('[FSM] sim trigger error', e); }
                  try{ const clock = new sim.SlotClock(Number(slot)); sim.slot_trigger(clock, Number(slot), execution).then(res=>{ console.error('[FSM] slot_trigger finished', res); }).catch(()=>{}); }catch(e){ console.error('[FSM] slot_trigger start error', e); }
                }catch(e){ console.error('[FSM] trigger handling error', e); }
              } else {
                // not ready after final probe
                this.emit('state', { mint: m, mask: s.mask, slot: s.slot, lastSeen: s.lastSeenTs, note: 'not_ready_after_final_reprobe' });
              }
            }catch(e){ console.error('[FSM] trigger outer error', e); }
          }
        })().catch(e=>{ console.error('[FSM] async handler error', e); });
      }
    }catch(e){ console.error('[ProgramFSM] event error', e); }
  }
}

if(require.main === module){
  const watcher = new ProgramFSM();
  watcher.on('state', s=>{ console.error('[FSM] state', JSON.stringify(s)); });
  watcher.on('trigger', t=>{ console.error('⚡ [FSM TRIGGER]', JSON.stringify(t)); });
  console.error('ProgramFSM watcher started');
}

module.exports = { ProgramFSM };
