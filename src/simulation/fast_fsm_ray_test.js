// fast_fsm_ray_test (stubbed)
#!/usr/bin/env node
console.error('fast_fsm_ray_test.js: removed — use `program_fsm_watcher.js` and Telegram integration.');
process.exit(0);
async function getTokenAccountsByMint(mint){
  try{
    const res = await heliusRpc('getTokenAccountsByMint', [mint, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
    return res;
  }catch(e){ return { __error: String(e) } }
}

async function checkMint(mint){
  const out = { mint };
  const ai = await heliusRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  out.accountInfo = ai;
  out.mask = 0;
  try{
    // use probe wrapper to take advantage of cache/retries
    const ai2 = ai && ai.value ? ai : await probeGetAccountInfo(mint);
    if(ai2 && ai2.value && ai2.value.data && ai2.value.data.program && ai2.value.data.program.includes('spl-token')){
      const info = ai2.value.data.parsed && ai2.value.data.parsed.info ? ai2.value.data.parsed.info : null;
      if(info && info.isInitialized) out.mask |= BIT_MINT_EXISTS;
      if(info && (!info.mintAuthority || info.mintAuthority === null)) out.mask |= BIT_AUTH_OK;
      if(info && (typeof info.decimals === 'number')) out.mask |= BIT_TRANSFERABLE;
    }
  }catch(e){}

  const ta = await probeTokenAccountsByMint(mint);
  out.tokenAccounts = ta;
  try{
    if(ta && Array.isArray(ta.value) && ta.value.length>0){
      for(const t of ta.value){
        const parsed = t.account && t.account.data && t.account.data.parsed ? t.account.data.parsed : null;
        const owner = parsed && parsed.info && parsed.info.owner ? parsed.info.owner : null;
        const amount = parsed && parsed.info && parsed.info.tokenAmount && parsed.info.tokenAmount.uiAmount ? parsed.info.tokenAmount.uiAmount : null;
        if(owner && owner === TARGET_PROGRAM) out.mask |= BIT_POOL_EXISTS;
        if(amount && amount > 0) out.mask |= BIT_POOL_INIT;
      }
    }
  }catch(e){}

  try{
    const jclient = createJupiterApiClient();
    const q = await jclient.quoteGet({ inputMint: 'So11111111111111111111111111111111111111112', outputMint: mint, amount: Math.floor(0.5 * 1e9), slippageBps: 100 });
    if(q && (q.outAmount || (q.routesInfos && q.routesInfos[0] && q.routesInfos[0].outAmount))){ out.mask |= (BIT_POOL_EXISTS|BIT_POOL_INIT); out.jupiter = q; }
  }catch(e){ out.jupiterErr = String(e); }

  // If not yet transferable, do a small jupiter probe (low-cost) to confirm tradability
  try{ if(!(out.mask & BIT_TRANSFERABLE)){ const jq2 = await probeJupiterSmallQuote(mint); if(jq2 && (jq2.outAmount || jq2.routePlan)) out.mask |= BIT_TRANSFERABLE; } }catch(e){}

  return out;
}

async function main(){
  console.error('Target program:', TARGET_PROGRAM);
  const findTimeout = Number(process.env.FIND_TIMEOUT_MS || 120000);
  const tok = await findMintForProgram(findTimeout);
  if(!tok){ console.error('No mint found for program within timeout'); process.exit(2); }
  console.error('Collected token:', JSON.stringify(tok, null, 2));
  const start = Date.now();
  const res = await checkMint(tok.mint || tok.tokenAddress || tok.address);
  const dur = Date.now() - start;
  console.error('Check duration ms:', dur, 'mask:', (res.mask||0).toString(2).padStart(4,'0'));
  console.error('Details:', JSON.stringify(res, null, 2));
  // require transferable as hard guard, then allow CORE or score-based path
  const hasTransferable = Boolean((res.mask||0) & BIT_TRANSFERABLE);
  const coreOk = (((res.mask||0) & CORE_MASK) === CORE_MASK);
  let score = 0;
  for(const [bit, w] of Object.entries(WEIGHTS)){
    try{ if((res.mask||0) & Number(bit)) score += Number(w); }catch(_e){}
  }
  console.error('Computed score:', score.toFixed(2), 'coreOk=', coreOk, 'transferable=', hasTransferable);
  if(hasTransferable && (coreOk || score >= SCORE_THRESHOLD)){
    console.error('READY → running simulation trigger (pre-final-reprobe)');
    // final quick reprobe for atomicity (<=50ms)
    try{
      await sleep(20);
      const ai3 = await probeGetAccountInfo(res.mint).catch(()=>null);
      const ta3 = await probeTokenAccountsByMint(res.mint).catch(()=>null);
      const jq3 = await probeJupiterSmallQuote(res.mint).catch(()=>null);
      let finalMask = res.mask || 0;
      try{ if(ai3 && ai3.value && ai3.value.data && ai3.value.data.parsed && ai3.value.data.parsed.info){ const info = ai3.value.data.parsed.info; if(info && info.isInitialized) finalMask |= BIT_MINT_EXISTS; if(info && (!info.mintAuthority || info.mintAuthority === null)) finalMask |= BIT_AUTH_OK; if(info && (typeof info.decimals === 'number')) finalMask |= BIT_TRANSFERABLE; } }catch(_){}
      try{ if(ta3 && Array.isArray(ta3.value) && ta3.value.length>0){ finalMask |= BIT_POOL_EXISTS; for(const t of ta3.value){ try{ const parsed = t && t.account && t.account.data && t.account.data.parsed; const amount = parsed && parsed.info && parsed.info.tokenAmount && parsed.info.tokenAmount.uiAmount ? parsed.info.tokenAmount.uiAmount : null; if(amount && amount>0) finalMask |= BIT_POOL_INIT; }catch(_){}} } }catch(_o){}
      try{ if(!(finalMask & BIT_TRANSFERABLE) && jq3 && (jq3.outAmount || jq3.routePlan)) finalMask |= BIT_TRANSFERABLE; }catch(_e){}
      // signature-based slot-sequence check using helius RPC
      try{
        const sigs = await heliusRpc('getSignaturesForAddress', [res.mint, { limit: 6 }]);
        const currSlot = tok && tok.firstBlock ? Number(tok.firstBlock) : null;
        if(Array.isArray(sigs) && currSlot){
          for(const e of sigs){
            const sslot = e && (e.slot || e.slotIndex || null);
            if(sslot && Number(sslot) === Number(currSlot) - 1){
              finalMask |= BIT_SLOT_SEQ; break;
            }
          }
        }
      }catch(_e){}
      if(finalMask !== (res.mask||0)) console.error('final reprobe mask changed', (res.mask||0).toString(2), '=>', (finalMask||0).toString(2));
    }catch(_e){ console.error('final reprobe error', _e); }
    const st = { token: res.mint, liquidity_usd: 12000, pool_initialized: true, is_transferable: !!(res.mask & BIT_TRANSFERABLE), mint_authority: !!(res.mask & BIT_AUTH_OK), freeze_authority: false };
    const execution = sim.pre_slot_analysis(st);
    console.error('⚡ SIMULATED → EXECUTION TRIGGER');
    execution.trigger();
    const clock = new sim.SlotClock(Number(tok.firstBlock || 100000));
    await sim.slot_trigger(clock, Number(tok.firstBlock || 100000), execution);
  } else {
    console.error('Not ready; no trigger.');
  }
}

if(require.main === module) main().catch(e=>{ console.error('fatal', e && e.stack||e); process.exit(1); });
