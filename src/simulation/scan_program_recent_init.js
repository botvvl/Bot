#!/usr/bin/env node
require('dotenv').config();
const axios = require('axios');
const { createJupiterApiClient } = require('@jup-ag/api');

const TARGET_PROGRAM = process.env.TARGET_PROGRAM || 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const HELIUS_RPC_URLS = (process.env.HELIUS_RPC_URLS || process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
const HELIUS_KEYS = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
if(HELIUS_RPC_URLS.length===0) HELIUS_RPC_URLS.push('https://mainnet.helius-rpc.com/');
let callIdx = 0;
async function heliusRpc(method, params){
  const url = HELIUS_RPC_URLS[callIdx % HELIUS_RPC_URLS.length];
  const headers = Object.assign({'Content-Type':'application/json'}, HELIUS_KEYS[callIdx % Math.max(1, HELIUS_KEYS.length)] ? { 'x-api-key': HELIUS_KEYS[callIdx % Math.max(1, HELIUS_KEYS.length)] } : {});
  callIdx = (callIdx + 1) >>> 0;
  try{ const r = await axios.post(url, { jsonrpc:'2.0', id:1, method, params }, { headers, timeout: 12000 }); return r.data && (r.data.result || r.data); }catch(e){ return { __error: e && e.message ? e.message : String(e) } }
}

async function getRecentSignatures(limit=50){
  return await heliusRpc('getSignaturesForAddress', [TARGET_PROGRAM, { limit }]);
}

async function inspectSignature(sig){
  const tx = await heliusRpc('getParsedTransaction', [sig, 'jsonParsed']);
  return tx;
}

function extractMintsFromParsed(tx){
  const mints = new Set();
  try{
    const meta = tx && (tx.meta || {});
    const logs = meta && meta.logMessages ? meta.logMessages : (tx && tx.logMessages) || [];
    for(const l of logs || []){
      const parts = l.split(/\s+/g);
      for(const p of parts){ if(p.length>=40 && p.length<=44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(p)) mints.add(p); }
    }
    const ins = tx && tx.transaction && tx.transaction.message && tx.transaction.message.instructions ? tx.transaction.message.instructions : [];
    for(const i of ins){
      if(i.accounts && Array.isArray(i.accounts)){
        for(const a of i.accounts) if(a && a.length>=40 && a.length<=44) mints.add(a);
      }
      if(i.parsed && i.parsed.info){
        const info = i.parsed.info;
        if(info.mint) mints.add(info.mint);
        if(info.tokenAccount) mints.add(info.tokenAccount);
      }
    }
  }catch(e){}
  return Array.from(mints);
}

async function main(){
  console.error('Scanning recent signatures for program', TARGET_PROGRAM);
  const sigs = await getRecentSignatures(80);
  if(!Array.isArray(sigs)) return console.error('No signatures', sigs);
  const results = [];
  for(const s of sigs.slice(0,60)){
    const sig = s.signature || s.sig || s.txHash || null;
    if(!sig) continue;
    const tx = await inspectSignature(sig);
    const mints = extractMintsFromParsed(tx);
    if(mints.length>0) results.push({ signature: sig, slot: s.slot || s.slotIndex || null, mints, txSummary: (tx && tx.meta && tx.meta.logMessages ? tx.meta.logMessages.slice(0,8) : []) });
  }
  console.log(JSON.stringify(results, null, 2));
}

if(require.main === module) main().catch(e=>{ console.error('fatal', e && e.stack||e); process.exit(1); });
