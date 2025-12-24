// =================== Imports ===================
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
// fernet has an ambient d.ts in repo; use require to avoid TS module mismatch
const { Fernet } = require('fernet');
import Binance from 'binance-api-node';
import axios from 'axios';
import crypto from 'crypto';
import { loadUsers, saveUsers, walletKeyboard, getErrorMessage, limitHistory, hasWallet } from './src/bot/helpers';
import { t, setUserLang, getAvailableLangs, tForLang } from './src/i18n';
import { helpMessages } from './src/helpMessages';
import { unifiedBuy, unifiedSell } from './src/tradeSources';
import { filterTokensByStrategy, registerBuyWithTarget, monitorAndAutoSellTrades } from './src/bot/strategy';
import { autoExecuteStrategyForUser } from './src/autoStrategyExecutor';
import { STRATEGY_FIELDS, buildTokenMessage, autoFilterTokens, notifyUsers, fetchDexScreenerTokens } from './src/utils/tokenUtils';
import { generateKeypair, exportSecretKey, parseKey } from './src/wallet';

const DEBUG = !!process.env.DEBUG && process.env.DEBUG !== '0';
function logt(...args: any[]) { if (DEBUG) console.log(...args); }
function warnt(...args: any[]) { if (DEBUG) console.warn(...args); }

logt('--- Bot starting: Imports loaded ---');

dotenv.config();

logt('--- dotenv loaded ---');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
logt('TELEGRAM_BOT_TOKEN present:', !!TELEGRAM_TOKEN);
if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not found in .env file. Please add TELEGRAM_BOT_TOKEN=YOUR_TOKEN to .env');
  process.exit(1);
}

const bot = new Telegraf(TELEGRAM_TOKEN as string);
logt('--- Telegraf instance created ---');

function escapeHtml(str: string){
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtNum(n: any, digits=4) {
  try {
    if (n === null || n === undefined) return 'n/a';
    const num = Number(n);
    if (Math.abs(num) >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (Math.abs(num) >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: digits });
    return num.toPrecision(Math.min(6, digits));
  } catch (e) { return String(n); }
}
function humanVol(v: any) {
  try {
    const n = Number(v);
    if (isNaN(n)) return String(v);
    if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(2) + 'K';
    return n.toString();
  } catch (e) { return String(v); }
}

// Map analyzer English advice phrases to translation keys so we can show localized advice
function localizeAdvice(userId: string, adviceArr: any[]) {
  if (!Array.isArray(adviceArr) || adviceArr.length === 0) return [];
  const mapping: Array<{match:string, key:string}> = [
    { match: 'Trend is bullish on the selected timeframe.', key: 'cex.advice_trend_bull' },
    { match: 'RSI high -> consider risk of short-term pullback.', key: 'cex.advice_rsi_high' },
    { match: 'High volatility detected; prefer smaller position sizes.', key: 'cex.advice_high_volatility' },
    { match: 'Trend is bearish. Prefer wait-or-short strategies.', key: 'cex.advice_trend_bear' },
    { match: 'RSI oversold -> short-term bounce possible.', key: 'cex.advice_rsi_oversold' },
    { match: 'Market mixed: consider waiting for clearer confirmation or use reduced size.', key: 'cex.advice_mixed' },
    { match: 'Volume is above recent average — move has momentum.', key: 'cex.advice_volume_high' },
    { match: 'Volume is well below recent average — move lacks conviction.', key: 'cex.advice_volume_low' },
    { match: 'No advice available', key: 'cex.advice_none' }
  ];
  const out: string[] = [];
  for (const a of adviceArr) {
    const s = String(a || '').trim();
    let found = false;
    for (const m of mapping) {
      if (s === m.match || s.indexOf(m.match) !== -1) {
        out.push(t(m.key, userId));
        found = true;
        break;
      }
    }
    if (!found) {
      // fallback: return original (escaped) string so user still sees content
      out.push(escapeHtml(s));
    }
  }
  return out;
}
function escapeRegex(s: string) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Helper to normalize various shapes returned by unifiedBuy/unifiedSell
function extractTx(res: any): string | null {
  if (!res) return null;
  if (typeof res === 'string') return res;
  if (res.tx) return String(res.tx);
  if ((res as any).txSignature) return String((res as any).txSignature);
  if ((res as any).signature) return String((res as any).signature);
  if ((res as any).buyResult) {
    const br = (res as any).buyResult;
    if (br.tx) return String(br.tx);
    if (br.signature) return String(br.signature);
  }
  return null;
}
// Detect dry-run / simulated buy sentinel so we don't report it as a real on-chain success
function isSimulatedBuy(res: any): boolean {
  if (!res) return false;
  try {
    // Common sentinel used in tradeSources: 'DRY-RUN-SIMULATED-TX'
    const tx = (typeof res === 'string') ? res : (res.tx || (res.buyResult && res.buyResult.tx) || null);
    if (tx && String(tx) === 'DRY-RUN-SIMULATED-TX') return true;
    // Also accept explicit simulated flag
    if (res.simulated === true || res.simulated === 'true') return true;
  } catch (e) {}
  return false;
}
// Validate notification payloads emitted by sniper.js notifier.
// Ensures we have a usable user id / chat id and returns normalized fields.
function validateNotificationPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return null;
  // payload.user is the canonical field; accept several aliases
  const rawUser = payload.user ?? payload.userId ?? payload.uid ?? null;
  const userId = rawUser !== null && rawUser !== undefined ? String(rawUser) : null;
  if (!userId || userId === 'null' || userId === 'undefined') return null;
  const chatId = (String(userId).match(/^\d+$/)) ? Number(userId) : userId;
  const tokens = Array.isArray(payload.tokens) ? payload.tokens : null;
  const html = typeof payload.html === 'string' ? payload.html : null;
  const inlineKeyboard = Array.isArray(payload.inlineKeyboard) ? payload.inlineKeyboard : null;
  return { userId, chatId, tokens, html, inlineKeyboard, raw: payload };
}
let users: Record<string, any> = loadUsers();
logt('--- Users loaded ---');

// Subscribe to in-process notifications emitted by `sniper.js` (collector/listener)
try{
  const sniperMod = require('./sniper.js');
  if(sniperMod && sniperMod.notifier && typeof sniperMod.notifier.on === 'function'){
    sniperMod.notifier.on('notification', async (payload: any) => {
      try{
        const v = validateNotificationPayload(payload);
        if(!v) return;
        const uid = v.userId;
        const chatId = v.chatId;
        // tokens may be provided directly or embedded in raw payload
        const tokens = v.tokens || (v.raw && v.raw.tokens) || (v.raw && v.raw.candidateTokens) || [];
        // If tokens is not an array but a single token object, normalize
        const tokenArr = Array.isArray(tokens) ? tokens : (tokens ? [tokens] : []);
        // Prefer existing html payload when present
        if(v.html){
          try{
            await bot.telegram.sendMessage(chatId, v.html, { parse_mode: 'HTML', reply_markup: { inline_keyboard: v.inlineKeyboard || [] } });
            return;
          }catch(e){}
        }
        // Else build and send token cards for each token (limit to 3)
        const tk = require('./src/utils/tokenUtils');
        const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || 'YourBotUsername';
        const toSend = tokenArr.slice(0,3);
        for(const tkn of toSend){
          try{
            // annotate message when mergedSignal is present
            let prefix = '';
            try{ if(tkn.mergedSignal) prefix = '✅ <b>MergedSignal</b> — live Sollet/Ledger agreement\n\n'; }catch(_e){}
            const pairAddress = tkn.pairAddress || tkn.tokenAddress || tkn.address || tkn.mint || '';
            const built = tk.buildTokenMessage(tkn, botUsername, pairAddress, uid);
            if(built && built.msg){
              const fullMsg = prefix + built.msg;
              await bot.telegram.sendMessage(chatId, fullMsg, { parse_mode: 'HTML', disable_web_page_preview: false, reply_markup: { inline_keyboard: built.inlineKeyboard } } as any);
            }
          }catch(e){ console.error('sniper->bot send token error', e); }
        }
      }catch(e){ }
    });
  }
}catch(e){ console.error('Failed to attach sniper notifier to bot', (e as any)?.message || e); }

// Sent-token hash helpers used by wsListener.ts — simple file-backed store
import cryptoHash from 'crypto';
const SENT_HASH_FILE = './sent_tokens/sent_hashes.json';
function ensureSentFile() {
  try {
    const p = require('path').resolve(SENT_HASH_FILE);
    const fs = require('fs');
    if (!fs.existsSync(require('path').dirname(p))) require('fs').mkdirSync(require('path').dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({}));
    return p;
  } catch (e) { return SENT_HASH_FILE; }
}
function hashTokenAddress(addr: string) {
  try {
    return cryptoHash.createHash('sha256').update(String(addr || '')).digest('hex');
  } catch (_) { return String(addr || ''); }
}
function readSentHashes(userId: string) {
  try {
    const fs = require('fs');
    const p = ensureSentFile();
    const data = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    const s = data[String(userId)] || [];
    return new Set(s);
  } catch (e) { return new Set(); }
}
function appendSentHash(userId: string, hash: string) {
  try {
    const fs = require('fs');
    const p = ensureSentFile();
    const data = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
    data[String(userId)] = data[String(userId)] || [];
    if (!data[String(userId)].includes(hash)) data[String(userId)].push(hash);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return true;
  } catch (e) { return false; }
}

export { hashTokenAddress, readSentHashes, appendSentHash };

// Ensure wallets are normalized at startup: dedupe, sort by createdAt, and set the last-added wallet as active
function normalizeAllUserWallets() {
  users = loadUsers();
  let dirty = false;
  for (const userId of Object.keys(users || {})) {
    const u: any = users[userId] || {};
    u.wallets = Array.isArray(u.wallets) ? u.wallets.slice() : [];

    // If legacy top-level wallet exists and not present in wallets[], add it
    if (u.wallet && u.secret) {
      const found = u.wallets.find((w: any) => w && w.wallet === u.wallet);
      if (!found) {
        u.wallets.push({ wallet: u.wallet, secret: u.secret, createdAt: Date.now() });
        dirty = true;
      } else if (!found.secret) {
        found.secret = u.secret;
        dirty = true;
      }
    }

    // Deduplicate by wallet address, keep the entry with the largest createdAt
    const map = new Map<string, any>();
    for (const item of u.wallets) {
      if (!item || !item.wallet) continue;
      const prev = map.get(item.wallet);
      if (!prev || (item.createdAt || 0) > (prev.createdAt || 0)) {
        map.set(item.wallet, { ...item });
      }
    }
    const arr = Array.from(map.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    u.wallets = arr;

    // Select the last-added (highest createdAt) as active
    if (u.wallets.length) {
      const active = u.wallets[u.wallets.length - 1];
      // mark active flag for clarity
      u.wallets = u.wallets.map((w: any) => ({ ...w, active: w.wallet === active.wallet }));
      if (u.wallet !== active.wallet || u.secret !== active.secret) {
        u.wallet = active.wallet;
        u.secret = active.secret;
        dirty = true;
      }
    } else {
      if (u.wallet || u.secret) {
        delete u.wallet;
        delete u.secret;
        dirty = true;
      }
    }
    users[userId] = u;
  }
  if (dirty) saveUsers(users);
}

// Run normalization once at startup so `user.wallet`/`user.secret` reflect the last-added wallet
try { normalizeAllUserWallets(); } catch (e) { console.error('Failed to normalize user wallets on startup', e); }

// --- Minimal crypto key storage (user-backed) ---
const FERNET_KEY = process.env.FERNET_KEY || '';
if (!FERNET_KEY) {
  warnt('FERNET_KEY not set in .env — keys will be stored as plain text unless you set FERNET_KEY.');
}
const _fernet = FERNET_KEY ? new Fernet(FERNET_KEY) : null;
function _maybeEncrypt(text: string) {
  if (_fernet) {
    try { return _fernet.encrypt(String(text)); } catch (e) { console.error('encrypt failed', e); }
  }
  return String(text);
}
function _maybeDecrypt(token: string) {
  if (_fernet) {
    try { return _fernet.decrypt(String(token)); } catch (e) { return null; }
  }
  return String(token);
}
async function cryptoAddUser(chatId: string, apiKey: string, apiSecret: string) {
  try {
    users = loadUsers();
    users[chatId] = users[chatId] || {};
    users[chatId].cex = { api_key: _maybeEncrypt(apiKey), api_secret: _maybeEncrypt(apiSecret) };
    saveUsers(users);
    return true;
  } catch (e) { console.error('cryptoAddUser (user-backed) failed', e); return false; }
}
async function cryptoGetUserKeys(chatId: string) {
  try {
    users = loadUsers();
    const u = users[chatId];
    if (!u || !u.cex) return null;
    const k = _maybeDecrypt(u.cex.api_key);
    const s = _maybeDecrypt(u.cex.api_secret);
    if (!k || !s) return null;
    return { apiKey: k, apiSecret: s };
  } catch (e) { console.error('cryptoGetUserKeys (user-backed) failed', e); return null; }
}
// Resilient MEXC validation helper: try a few plausible endpoints/signing styles
async function tryMexcValidation(apiKey: string, apiSecret: string) {
  const attempts: Array<{ url: string, keyHeader?: string, useSignatureInQuery?: boolean }> = [
    // common candidate (v3-like)
    { url: 'https://api.mexc.com/api/v3/account', keyHeader: 'ApiKey', useSignatureInQuery: true },
    // alternative header name
    { url: 'https://api.mexc.com/api/v3/account', keyHeader: 'X-MEXC-APIKEY', useSignatureInQuery: true },
    // older v2 endpoint observed in some docs (may be behind cloudflare)
    { url: 'https://api.mexc.com/api/v2/account/info', keyHeader: 'ApiKey', useSignatureInQuery: true }
  ];

  let lastErr: any = null;
  for (const a of attempts) {
    try {
      const ts = Date.now();
      const recvWindow = 5000;
      // build a simple query string commonly used by many exchanges
      const qs = `timestamp=${ts}&recvWindow=${recvWindow}`;
      const sign = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
      let fullUrl = a.useSignatureInQuery ? `${a.url}?${qs}&signature=${sign}` : `${a.url}`;
      const headers: Record<string, string> = { 'User-Agent': 'bot/1.0', 'Content-Type': 'application/json' };
      if (a.keyHeader) headers[a.keyHeader] = apiKey;
      // Some endpoints expect the api key as a query param instead
      if (!a.keyHeader) fullUrl += (fullUrl.includes('?') ? '&' : '?') + `apiKey=${encodeURIComponent(apiKey)}`;

      const res = await axios.get(fullUrl, { headers, timeout: 8000 });
      if (res && res.data) {
        // MEXC successful responses often include balances or code===0
        const d = res.data;
        if (Array.isArray(d.balances) || d.balances || d.code === 0 || d.success === true) {
          return d;
        }
        // sometimes returns an object with data field
        if (d.data && (Array.isArray(d.data.balances) || d.data.balances)) return d.data;
        // otherwise treat as success if status 200 and a JSON body
        if (res.status === 200) return d;
      }
    } catch (err) {
      lastErr = err;
      // continue to next attempt
      continue;
    }
  }
  throw lastErr || new Error('MEXC validation: no successful response');
}
// pending map held in memory for CONFIRM/CANCEL flow
if (!(globalThis as any).__pendingKeys) (globalThis as any).__pendingKeys = new Map<string, { k: string, s: string }>();
// expecting set: when user presses the CEX sniper button we ask them to paste keys
if (!(globalThis as any).__expectingCexKeys) (globalThis as any).__expectingCexKeys = new Set<string>();
// partial entries: if user sends APIKEY then SECRET in separate messages
if (!(globalThis as any).__pendingPartial) (globalThis as any).__pendingPartial = new Map<string, { k?: string, s?: string }>();
// Expectation sets for CEX interactive flows
if (!(globalThis as any).__expectingCexTokenAnalysis) (globalThis as any).__expectingCexTokenAnalysis = new Set<string>();
if (!(globalThis as any).__expectingCexTradeRequest) (globalThis as any).__expectingCexTradeRequest = new Set<string>();

// Dedicated text handler for API key storage (CONFIRM/CANCEL and APIKEY:SECRET)
bot.on('text', async (ctx, next) => {
  try {
    let text = (ctx.message as any).text?.trim();
    const chatId = String(ctx.from?.id);
    if (!text) return typeof next === 'function' ? next() : undefined;
    const pending = (globalThis as any).__pendingKeys as Map<string, { k: string, s: string }>;
    const expecting = (globalThis as any).__expectingCexKeys as Set<string>;
    const partial = (globalThis as any).__pendingPartial as Map<string, { k?: string, s?: string }>;
    // If we are expecting keys from this user, accept multiple formats:
    // - APIKEY:SECRET
    // - APIKEY\nSECRET
    // - APIKEY SECRET
    // - APIKEY (then send SECRET in a second message)
    if (expecting && expecting.has(chatId)) {
      const isControl = text.toUpperCase() === 'CONFIRM' || text.toUpperCase() === 'CANCEL' || text.toUpperCase().startsWith('TEST:');
      // If user sent a control command, allow it to be handled below
      if (!isControl) {
        // try newline split
        if (text.includes('\n')) {
          const parts = text.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
          if (parts.length >= 2) {
            // treat as apiKey:secret (use local variable instead of mutating ctx.message.text)
            text = `${parts[0]}:${parts[1]}`;
          }
        } else if (text.includes(':') || text.includes(' ')) {
          // leave as-is (will be parsed below)
        } else {
          // no delimiter and not a control command -> could be a partial API key or secret
          const existingPartial = partial.get(chatId);
            if (existingPartial && existingPartial.k && !existingPartial.s) {
            // treat current text as secret and continue
            const apiKey = existingPartial.k;
            const apiSecret = text.trim();
            partial.delete(chatId);
            // perform validation & save flow using local variable
            text = `${apiKey}:${apiSecret}`;
          } else {
            // store as partial API key and ask for secret
            partial.set(chatId, { k: text.trim() });
            try { await ctx.reply(t('cex.received_partial_key', chatId)); } catch (_) {}
            return;
          }
        }
      }
    }
    // If user is expected to send a token for analysis
    const expectingAnalysis = (globalThis as any).__expectingCexTokenAnalysis as Set<string>;
    if (expectingAnalysis && expectingAnalysis.has(chatId)) {
      // treat the entire text as the token identifier and run analysis
      expectingAnalysis.delete(chatId);
      try {
        const cex = require('./cexSniper.js');
  await ctx.reply(t('cex.analysis_running', chatId));
  // try to detect user's saved platform and pass to analyzer
  users = loadUsers();
  const u = users[chatId] || {};
  const platform = (u.cex && u.cex.platform) ? u.cex.platform : undefined;
  const res = await cex.analyzeSymbol(chatId, text, { platform });
        if (!res || !res.ok) {
          console.error('analysis failed', res);
          await ctx.reply(t('cex.analysis_failed', chatId, { symbol: text, err: (res && (res.err || res.stderr)) || 'no_output' }));
          return;
        }
        // format summary from res.data (enriched)
        const data = res.data || {};
        // If analyzer returned an error (e.g. symbol not found), reply with a clear message
        if (data && data.error) {
          try {
            await ctx.reply(t('cex.analysis_symbol_not_found', chatId, { symbol: String(text), err: String(data.error) }));
          } catch (e) {}
          // still record the failed analysis
          try { cex.addTradeRecord(chatId, { action: 'analyze_result_error', symbol: text, err: data.error }); } catch (_) {}
          return;
        }
        // build an HTML message with key fields
        const lines: string[] = [];
        lines.push(`<b>🔎 ${escapeHtml(String(data.symbol || text))} — ${escapeHtml(String(data.timeframe || ''))}</b>`);
        lines.push(`<b>${t('cex.analysis_signal', chatId)}:</b> ${escapeHtml(String(data.signal || 'n/a'))}  |  <b>${t('cex.analysis_score', chatId)}:</b> ${escapeHtml(String(data.score !== undefined ? String(data.score) : 'n/a'))}`);
        if (Array.isArray(data.rationale) && data.rationale.length) {
          lines.push(`<b>${t('cex.analysis_rationale', chatId)}:</b> ${escapeHtml(data.rationale.join(', '))}`);
        }
        if (data.indicators) {
          const ind = data.indicators;
          const indParts: string[] = [];
          if (ind.EMA50 !== undefined) indParts.push(`EMA50:${escapeHtml(String(ind.EMA50))}`);
          if (ind.EMA200 !== undefined) indParts.push(`EMA200:${escapeHtml(String(ind.EMA200))}`);
          if (ind.MACD !== undefined) indParts.push(`MACD:${escapeHtml(String(ind.MACD))}`);
          if (ind.MACD_hist !== undefined) indParts.push(`MACD_hist:${escapeHtml(String(ind.MACD_hist))}`);
          if (ind.StochRSI !== undefined) indParts.push(`StochRSI:${escapeHtml(String(ind.StochRSI))}`);
          if (indParts.length) lines.push(`<b>${t('cex.analysis_indicators', chatId)}:</b> ${escapeHtml(indParts.join(' | '))}`);
        }
        // ATR, prices, volumes
        const atrText = (data.atr !== undefined && data.atr !== null) ? String(data.atr) : 'n/a';
        const atrPctText = (data.atr_pct !== undefined && data.atr_pct !== null) ? (Number(data.atr_pct) * 100).toFixed(2) + '%' : 'n/a';
        lines.push(`<b>${t('cex.analysis_price', chatId)}:</b> ${escapeHtml(String(data.close || 'n/a'))}  (<b>${t('cex.analysis_change', chatId)}:</b> ${escapeHtml(String(data.close_change !== undefined && data.close_change !== null ? (Number(data.close_change)*100).toFixed(2)+'%' : 'n/a'))})`);
        // sparkline (if provided)
        if (data.sparkline) {
          lines.push(`<code>${escapeHtml(String(data.sparkline))}</code>`);
        }
        lines.push(`<b>${t('cex.analysis_atr', chatId)}:</b> ${escapeHtml(atrText)}  (<b>%</b> ${escapeHtml(atrPctText)})`);
        lines.push(`<b>${t('cex.analysis_volume', chatId)}:</b> ${escapeHtml(String(data.volume !== undefined ? String(data.volume) : 'n/a'))}  (<b>Δ</b> ${escapeHtml(data.volume_change !== undefined && data.volume_change !== null ? (Number(data.volume_change)*100).toFixed(2)+'%' : 'n/a')})`);
        // trend / advice
        if (data.trend) {
          // nicer score bar
          if (data.score !== undefined && data.score !== null) {
            try {
              const sc = Math.max(0, Math.min(100, Number(data.score)));
              const filled = Math.round((sc/100) * 10);
              const empty = 10 - filled;
              const bar = '🟩'.repeat(filled) + '⬜'.repeat(empty);
              lines.push(`<b>${t('cex.analysis_score', chatId)}:</b> ${escapeHtml(String(sc))} ${escapeHtml(bar)}`);
            } catch (e) { lines.push(`<b>${t('cex.analysis_score', chatId)}:</b> ${escapeHtml(String(data.score))}`); }
          }
          lines.push(`<b>${t('cex.analysis_trend', chatId)}:</b> ${escapeHtml(String(data.trend))}  |  <b>${t('cex.analysis_position', chatId)}:</b> ${escapeHtml(String(data.position_sizing || 'n/a'))}`);
        }
        if (Array.isArray(data.advice) && data.advice.length) {
          const localized = localizeAdvice(chatId, data.advice);
          lines.push(`<b>${t('cex.analysis_advice', chatId)}:</b> ${escapeHtml(localized.join(' \n'))}`);
        }
        if (data.rsi !== undefined && data.rsi !== null) {
          lines.push(`<b>RSI:</b> ${escapeHtml(String(Number(data.rsi).toFixed(2)))}  |  <b>EMA slope:</b> ${escapeHtml(data.ema_slope !== null && data.ema_slope !== undefined ? (Number(data.ema_slope)*100).toFixed(2)+'%' : 'n/a')}`);
        }
        // suggested levels
        if (data.suggested) {
          const s = data.suggested;
          lines.push(`<b>${t('cex.analysis_suggested', chatId)}:</b> ${t('cex.analysis_entry', chatId)} ${escapeHtml(fmtNum(s.entry,6))} — ${t('cex.analysis_sl', chatId)} ${escapeHtml(fmtNum(s.sl,6))} — ${t('cex.analysis_tp', chatId)} ${escapeHtml(fmtNum(s.tp,6))}`);
          lines.push(`<b>${t('cex.analysis_risk', chatId)}:</b> ${escapeHtml(String(s.risk_pct))}%`);
        }
        // recommendation (structured)
        if (data.recommendation) {
          try {
            const rec = data.recommendation as any;
            // map action to localized label
            const actionMap: Record<string,string> = {
              'enter_long': t('cex.reco_enter_long', chatId),
              'enter_short': t('cex.reco_enter_short', chatId),
              'consider_enter': t('cex.reco_consider', chatId),
              'wait': t('cex.reco_wait', chatId)
            };
            const actionLabel = actionMap[rec.action] || escapeHtml(String(rec.action || 'n/a'));
            lines.push(`<b>${t('cex.analysis_recommendation', chatId)}:</b> ${escapeHtml(actionLabel)}`);
            if (rec.entry !== undefined && rec.entry !== null) lines.push(`<b>${t('cex.analysis_entry', chatId)}:</b> ${escapeHtml(fmtNum(rec.entry,6))}`);
            if (Array.isArray(rec.entry_zone) && rec.entry_zone.length===2) lines.push(`<b>${t('cex.analysis_entry', chatId)} ${t('cex.analysis_zone', chatId)}:</b> ${escapeHtml(fmtNum(rec.entry_zone[0],6))} - ${escapeHtml(fmtNum(rec.entry_zone[1],6))}`);
            if (rec.sl !== undefined && rec.sl !== null) lines.push(`<b>${t('cex.analysis_sl', chatId)}:</b> ${escapeHtml(fmtNum(rec.sl,6))}`);
            if (Array.isArray(rec.tps) && rec.tps.length) {
              const tps = rec.tps.map((x: any, i: number) => `${t('cex.analysis_tp', chatId)}${i+1}:${fmtNum(x,6)}`);
              lines.push(`<b>${t('cex.analysis_tp', chatId)}s:</b> ${escapeHtml(tps.join(' | '))}`);
            }
            if (rec.risk_pct !== undefined && rec.risk_pct !== null) lines.push(`<b>${t('cex.analysis_risk', chatId)}:</b> ${escapeHtml(String(rec.risk_pct))}%`);
            // show explanation lines (try to localize simple codes if present)
            if (Array.isArray(rec.explain) && rec.explain.length) {
              // prefer structured explain_codes localization when available
              if (Array.isArray(rec.explain_codes) && rec.explain_codes.length) {
                const localizedExplain: string[] = [];
                for (const ec of rec.explain_codes) {
                  try {
                    const code = String(ec.code || '');
                    const vars = (ec.vars && typeof ec.vars === 'object') ? ec.vars : undefined;
                    const translated = t(`cex.${code}`, chatId, vars as any);
                    if (translated && translated !== `cex.${code}`) localizedExplain.push(translated);
                    else localizedExplain.push(escapeHtml(String(ec.text || '')));
                  } catch (e) { localizedExplain.push(escapeHtml(String(ec.text || ''))); }
                }
                lines.push(`<b>${t('cex.analysis_explain', chatId)}:</b> ${escapeHtml(localizedExplain.join(' \n '))}`);
              } else {
                const explainLines = rec.explain.map((ln: string) => escapeHtml(String(ln)));
                lines.push(`<b>${t('cex.analysis_explain', chatId)}:</b> ${explainLines.join(' \n ')}`);
              }
            }
          } catch (e) { /* ignore render error */ }
        }
        // higher timeframe bias
        if (data.higher_timeframe_bias) {
          const parts: string[] = [];
          for (const k of Object.keys(data.higher_timeframe_bias)) {
            parts.push(`${k}: ${data.higher_timeframe_bias[k]}`);
          }
          lines.push(`<b>${t('cex.analysis_ht_bias', chatId)}:</b> ${escapeHtml(parts.join(' | '))}`);
        }

        const html = lines.join('\n');
        // suggest buy button
        const defaultUsdt = 50;
        const rows: any[] = [ [ { text: '✅ ' + t('cex.suggest_buy', chatId), callback_data: `cex_suggest_buy_${encodeURIComponent(text)}` }, { text: t('cex.cancel_button', chatId), callback_data: 'cex_cancel' } ] ];
        await ctx.reply(html, { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' } as any);
        cex.addTradeRecord(chatId, { action: 'analyze_result', symbol: text, analysis: data });
      } catch (e: any) { console.error('analysis request error', e); await ctx.reply(t('cex.analysis_failed', chatId, { symbol: text, err: (e && e.message) || String(e) })); }
      return;
    }
    // If user is expected to send trade request details
    const expectingTrades = (globalThis as any).__expectingCexTradeRequest as Set<string>;
    if (expectingTrades && expectingTrades.has(chatId)) {
      expectingTrades.delete(chatId);
      try {
  await ctx.reply(t('cex.trade_request_received', chatId, { details: text }));
        const cex = require('./cexSniper.js');
        cex.addTradeRecord(chatId, { action: 'trade_request', details: text });
      } catch (e: any) { console.error('trade request error', e); }
      return;
    }
  if (String(text).toUpperCase() === 'CONFIRM') {
      if (pending && pending.has(chatId)) {
        const p = pending.get(chatId)!;
        const ok = await cryptoAddUser(chatId, p.k, p.s);
        pending.delete(chatId);
  return ctx.reply(ok ? t('cex.api_keys_saved', chatId) : t('cex.api_keys_save_failed', chatId));
      }
  return ctx.reply(t('cex.no_pending_confirm', chatId));
    }
  if (String(text).toUpperCase() === 'CANCEL') {
      if (pending && pending.has(chatId)) {
        pending.delete(chatId);
  return ctx.reply(t('cex.pending_discarded', chatId));
      }
  return ctx.reply(t('cex.no_pending_cancel', chatId));
    }

    if (text.includes(':')) {
        // Support TEST:APIKEY:SECRET for ephemeral tests without saving
        if (String(text).toUpperCase().startsWith('TEST:')) {
          const payload = String(text).split(':').slice(1);
          // Accept TEST:API:SECRET or TEST:PLATFORM:API:SECRET
          if (payload.length === 2) {
            const apiKey = payload[0].trim();
            const apiSecret = payload[1].trim();
            try {
              const client = Binance({ apiKey, apiSecret });
              const info = await client.accountInfo();
              const usdt = (info && info.balances) ? (info.balances.find((b: any) => b.asset === 'USDT') || null) : null;
              const free = usdt ? Number(usdt.free || 0) : 0;
              const locked = usdt ? Number(usdt.locked || 0) : 0;
              let msg = `💰 USDT balance (ephemeral test): free=${free}, locked=${locked}\n`;
              msg += `Account permissions: ${info && info.permissions ? info.permissions.join(', ') : 'unknown'}\n`;
              msg += '⚠️ This was a test-only check. No keys were saved.';
              await ctx.reply(msg);
            } catch (e: any) {
              console.error('TEST ephemeral check failed', e);
              await ctx.reply(t('cex.ephemeral_test_failed', chatId, { err: (e && e.message ? e.message : String(e)) }));
            }
            return;
          } else if (payload.length >= 3) {
            // TEST:PLATFORM:API:SECRET (treat platform-aware)
            const platform = payload[0].trim().toUpperCase();
            const apiKey = payload[1].trim();
            const apiSecret = payload.slice(2).join(':').trim();
            if (!apiKey || !apiSecret) return ctx.reply(t('cex.invalid_test_format', chatId));
            if (platform === 'BINANCE') {
              try {
                const client = Binance({ apiKey, apiSecret });
                const info = await client.accountInfo();
                const usdt = (info && info.balances) ? (info.balances.find((b: any) => b.asset === 'USDT') || null) : null;
                const free = usdt ? Number(usdt.free || 0) : 0;
                const locked = usdt ? Number(usdt.locked || 0) : 0;
                let msg = `💰 USDT balance (ephemeral test - Binance): free=${free}, locked=${locked}\n`;
                msg += `Account permissions: ${info && info.permissions ? info.permissions.join(', ') : 'unknown'}\n`;
                msg += '⚠️ This was a test-only check. No keys were saved.';
                await ctx.reply(msg);
              } catch (e: any) {
                console.error('TEST ephemeral check failed (binance)', e);
                await ctx.reply(t('cex.ephemeral_test_failed', chatId, { err: (e && e.message ? e.message : String(e)) }));
              }
              return;
            }
            // For other platforms we don't have validation implemented — inform user
            await ctx.reply(t('cex.test_not_implemented', chatId, { platform }));
            return;
          } else {
            return ctx.reply(t('cex.invalid_test_format', chatId));
          }
        }

        // Support PLATFORM:API:SECRET (3 parts) or API:SECRET (2 parts)
  const allParts = String(text).split(':').map((s: string) => s.trim()).filter(Boolean);
        let platform = 'BINANCE';
        let apiKey = '';
        let apiSecret = '';
        if (allParts.length === 2) {
          apiKey = allParts[0];
          apiSecret = allParts[1];
        } else if (allParts.length >= 3) {
          // PLATFORM:API:SECRET (platform may be one word)
          platform = allParts[0].toUpperCase();
          apiKey = allParts[1];
          apiSecret = allParts.slice(2).join(':');
        } else {
          return ctx.reply(t('cex.invalid_format', chatId));
        }
  if (!apiKey || !apiSecret) return ctx.reply(t('cex.invalid_format', chatId));
      // If we weren't explicitly expecting keys from this user, ignore
      const expecting = (globalThis as any).__expectingCexKeys as Set<string>;
    if (!expecting || !expecting.has(chatId)) {
  return ctx.reply(t('cex.not_expecting_keys', chatId));
      }
      // attempt to validate keys by calling the platform API when supported (Binance, MEXC, Bybit, Gate)
      try {
        let info: any = null;
        if (platform === 'BINANCE') {
          const client = Binance({ apiKey, apiSecret });
          info = await client.accountInfo();
        } else if (platform === 'MEXC') {
          // Use a resilient validator that tries a few plausible MEXC endpoint/sign styles
          try {
            info = await tryMexcValidation(apiKey, apiSecret);
          } catch (err) {
            const e: any = err;
            console.error('MEXC validation failed', e?.message || e?.response?.data || e);
            throw new Error('MEXC validation failed: ' + (e && e.message ? e.message : String(e)));
          }
        } else if (platform === 'BYBIT') {
          // Bybit: GET /v2/private/wallet/balance (?) - For example purpose use /v2/private/account/wallet-balance
          try {
            const ts = Date.now();
            const params = `api_key=${apiKey}&timestamp=${ts}`;
            const sign = crypto.createHmac('sha256', apiSecret).update(params).digest('hex');
            const url = `https://api.bybit.com/v2/private/wallet/balance?${params}&sign=${sign}`;
            const res = await axios.get(url);
            info = res.data;
          } catch (err) {
            const e: any = err;
            console.error('Bybit validation failed', e?.response?.data || e.message || e);
            throw new Error('Bybit validation failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : String(e)));
          }
        } else if (platform === 'GATE' || platform === 'GATEIO') {
          // Gate.io: GET /spot/accounts requires API key + signing
          try {
            const endpoint = '/api/v4/wallet/balances';
            const ts = Math.floor(Date.now() / 1000);
            const payload = `${ts}GET${endpoint}`;
            const sign = crypto.createHmac('sha512', apiSecret).update(payload).digest('hex');
            const url = `https://api.gate.io${endpoint}`;
            const res = await axios.get(url, { headers: { 'KEY': apiKey, 'Timestamp': String(ts), 'SIGN': sign } });
            info = res.data;
          } catch (err) {
            const e: any = err;
            console.error('Gate validation failed', e?.response?.data || e.message || e);
            throw new Error('Gate validation failed: ' + (e && e.response && e.response.data ? JSON.stringify(e.response.data) : String(e)));
          }
        } else {
          // For unsupported CEXes we skip live validation
          info = null;
        }
        const usdt = (info && info.balances) ? (info.balances.find((b: any) => b.asset === 'USDT') || null) : null;
        const free = usdt ? Number(usdt.free || 0) : 0;
        const locked = usdt ? Number(usdt.locked || 0) : 0;
  // Format balances similar to the example (use exponential if small)
  const fmtFree = (Math.abs(free) < 1e-6) ? free.toExponential() : String(free);
  const fmtLocked = (Math.abs(locked) < 1e-6) ? locked.toExponential() : String(locked);
  // default to SPOT for MEXC if permissions not provided
  const permissionsText = (info && info.permissions) ? (Array.isArray(info.permissions) ? info.permissions.join(', ') : String(info.permissions)) : (platform === 'MEXC' ? 'SPOT' : (platform === 'BINANCE' ? 'unknown' : 'validation skipped for platform ' + platform));
  const msg = t('cex.key_validation_success', chatId, { free: fmtFree, locked: fmtLocked, permissions: permissionsText });
        // Save or mark pending depending on existing keys
        const existing = await cryptoGetUserKeys(chatId);
        if (!existing) {
          const ok = await cryptoAddUser(chatId, apiKey, apiSecret);
          // store platform
          users = loadUsers();
          users[chatId] = users[chatId] || {};
          users[chatId].cex = users[chatId].cex || {};
          users[chatId].cex.platform = platform;
          saveUsers(users);
          expecting.delete(chatId);
          // For MEXC produce the exact requested message
          if (ok && platform === 'MEXC') {
            const reply = msg + '\n\n' + t('cex.api_keys_saved', chatId) + ' Platform: MEXC';
            return ctx.reply(reply);
          }
          return ctx.reply(ok ? (msg + '\n\n' + t('cex.api_keys_saved', chatId) + ' Platform: ' + platform) : t('cex.api_keys_save_failed', chatId));
        }
  // if exist, set pending and ask for confirmation. store platform in pending too
  pending.set(chatId, { k: apiKey, s: apiSecret });
  // persist platform in pending map (store separate map entry)
  try { (pending as any).__platforms = (pending as any).__platforms || new Map(); (pending as any).__platforms.set(chatId, platform); } catch (_) {}
  expecting.delete(chatId);
  return ctx.reply(msg + '\n\n' + t('cex.already_have_keys', chatId, { platform }), { parse_mode: 'HTML' });
      } catch (e: any) {
        console.error('API key validation failed', e);
        return ctx.reply(t('cex.key_validation_failed', chatId, { err: (e && e.message ? e.message : String(e)) }));
      } finally {
        try { expecting.delete(chatId); } catch (_) {}
      }
    }
  } catch (e) {
    console.error('API key text handler error', e);
  }
  if (typeof next === 'function') return next();
});

// Optional: start sniper in-process and forward notifications to Telegram users.
if (String(process.env.START_SNIPER_IN_PROCESS || '').toLowerCase() === 'true') {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - dynamic require of JS module
  const sniperMod = require('./sniper.js');
    if (sniperMod) {
      try {
        // start the long-running listener in background
        if (typeof sniperMod.startSequentialListener === 'function') {
          (async () => {
            try { await sniperMod.startSequentialListener(); } catch (e) { console.error('[sniper] startSequentialListener failed', e); }
          })();
        }
        // subscribe to in-process notifier events
        if (sniperMod.notifier && typeof sniperMod.notifier.on === 'function') {
          sniperMod.notifier.on('notification', async (payload: any) => {
            try {
              const validated = validateNotificationPayload(payload);
              if (!validated) {
                console.error('[sniper->telegram] malformed payload received, skipping', { payload });
                return;
              }
              const { userId, chatId, tokens, html, inlineKeyboard } = validated;

              // If payload already contains a prebuilt HTML message, use it.
              if (html) {
                try {
                  await bot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: inlineKeyboard || undefined } as any);
                } catch (e: any) {
                  console.error('[sniper->telegram] failed to send provided html payload', e ? (e instanceof Error ? e.message : String(e)) : 'unknown');
                }
                return;
              }

              const tokensArr = Array.isArray(tokens) ? tokens : [];
              if (tokensArr.length === 0) return;

              // reload users and pick up user's settings
              users = loadUsers();
              const userObj = users && users[userId] ? users[userId] : {};

              // For each token, send a short notification and run simulate-only buy in background.
              for (const tok of tokensArr.slice(0, 20)) {
                try {
                  const tokenAddress = tok && (tok.tokenAddress || tok.address || tok.mint || tok.pairAddress) || String(tok);
                  try { await bot.telegram.sendMessage(chatId, `🔔 Buying token: <code>${tokenAddress}</code> — simulation running in background.`, { parse_mode: 'HTML' } as any); } catch (e) { console.error('[sniper->telegram] brief notify failed', e ? (e instanceof Error ? e.message : String(e)) : 'unknown'); }

                  (async () => {
                    try {
                      const tokenObj = { mint: tokenAddress, createdAt: tok.firstBlockTime || tok.firstBlock || null, __listenerCollected: true };
                      await autoExecuteStrategyForUser(userObj, [tokenObj], 'buy', { simulateOnly: true, listenerBypass: true });
                    } catch (bgErr) {
                      console.error('[sniper->autoExec background error]', bgErr ? (bgErr instanceof Error ? bgErr.message : String(bgErr)) : 'unknown');
                    }
                  })();
                  } catch (e) {
                    console.error('[sniper->telegram] per-token handler error', e ? (e instanceof Error ? e.message : String(e)) : 'unknown');
                }
              }
            } catch (e: any) {
              console.error('[sniper->telegram] notification handler error', e ? (e instanceof Error ? e.message : String(e)) : 'unknown');
            }
          });
        }
      } catch (e) { console.error('Failed to initialize in-process sniper module', e); }
    }
  } catch (e) { console.error('START_SNIPER_IN_PROCESS require error', e); }
}

let globalTokenCache: any[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 1000 * 60 * 2;
let boughtTokens: Record<string, Set<string>> = {};
const restoreStates: Record<string, boolean> = {};

function getMainReplyKeyboard(userId?: string) {
  // Use the exact translated labels for the main keyboard (no additions or counts)
  return Markup.keyboard([
    [t('main.wallet', userId), t('main.strategy', userId)],
    [t('main.show_tokens', userId), t('main.invite_friends', userId)],
    [t('main.sniper', userId), t('main.sniper_cex', userId)],
    [t('main.language', userId)]
  ]).resize();
}

// Helper: test whether the incoming text matches the translation for key in user's lang
function matchesLabel(text: string, key: string, userId?: string) {
  text = String(text || '').trim();
  // first test user's current language
  const userLang = (userId && (loadUsers()[String(userId)] || {}).lang) || undefined;
  const candidates = new Set<string>();
  try {
    // user's lang first
    candidates.add(t(key, userId));
    // all available langs
    const langs = getAvailableLangs();
    for (const l of langs) candidates.add(tForLang(key, l));
  } catch (e) {}
  for (const c of Array.from(candidates)) {
    if (!c) continue;
    if (String(c).trim() === text) return true;
  }
  return false;
}

bot.start(async (ctx) => {
  const userId = String(ctx.from?.id);
  await ctx.reply(
    t('common.welcome', userId),
    getMainReplyKeyboard(userId)
  );
  const usersAll = loadUsers();
  const u = usersAll[userId] || {};
  if (!u.lang) {
    const langs = getAvailableLangs();
    const buttons = langs.map(l => Markup.button.callback(l, `setlang_${l}`));
    const rows: any[] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply(t('main_extra.choose_language', userId), { reply_markup: { inline_keyboard: rows } } as any);
  }
});

// Handler for suggestion buy button from analysis
bot.action(/cex_suggest_buy_(.+)/, async (ctx: any) => {
  try {
    const data = String((ctx.callbackQuery as any).data || '');
    const m = data.match(/^cex_suggest_buy_(.+)$/);
    if (!m) return;
    const symbol = decodeURIComponent(m[1]);
    const userId = String(ctx.from?.id);
    // default trade size (USDT) — try to read from user's strategy or fallback to 50
    users = loadUsers();
    const user = users[userId] || {};
    const defaultUsdt = (user && user.strategy && user.strategy.buyAmount) ? Number(user.strategy.buyAmount) : 50;
  const rows: any[] = [ [ { text: '✅ ' + t('cex.suggest_buy', userId), callback_data: `cex_confirm_buy_${encodeURIComponent(symbol)}_${defaultUsdt}` }, { text: t('cex.cancel_button', userId), callback_data: 'cex_cancel' } ] ];
  await ctx.reply(t('cex.confirm_buy_prompt', userId, { symbol, amount: String(defaultUsdt) }), { reply_markup: { inline_keyboard: rows } } as any);
  } catch (e: any) { console.error('cex_suggest_buy error', e); await ctx.reply(t('cex.internal_error', String(ctx.from?.id))); }
});

// Confirm buy handler — runs filters then calls executeOrder (stubbed unless ENABLE_CEX_EXECUTION=true)
bot.action(/cex_confirm_buy_(.+)_(.+)/, async (ctx: any) => {
  try {
    const data = String((ctx.callbackQuery as any).data || '');
    const m = data.match(/^cex_confirm_buy_(.+)_(.+)$/);
    if (!m) return;
    const symbol = decodeURIComponent(m[1]);
    const usdtSize = Number(m[2]) || 50;
    const userId = String(ctx.from?.id);
    // get keys
    const keys = await cryptoGetUserKeys(userId);
    if (!keys) return ctx.reply(t('cex.no_keys_saved', userId));
    const cex = require('./cexSniper.js');
    // re-run analysis to ensure filters pass
  // re-run analysis using user's configured platform when available
  users = loadUsers();
  const u2 = users[userId] || {};
  const platform2 = (u2.cex && u2.cex.platform) ? u2.cex.platform : undefined;
  const analysisRes = await cex.analyzeSymbol(userId, symbol, { platform: platform2 });
    if (!analysisRes || !analysisRes.ok) return ctx.reply(t('cex.analysis_no_results', userId));
    const pass = cex._passesFilters(analysisRes.data, {});
    if (!pass || !pass.ok) return ctx.reply(t('cex.filtered_security', userId, { reason: String(pass.reason || pass.err || 'filtered') }));
    const execRes = await cex.executeOrder(userId, symbol, 'BUY', usdtSize, keys, {});
    if (execRes && execRes.ok) {
      return ctx.reply(t('cex.buy_recorded_generic', userId, { res: JSON.stringify(execRes) }));
    }
    return ctx.reply(t('cex.buy_failed', userId, { err: (execRes && execRes.err ? String(execRes.err) : 'unknown') }));
  } catch (e: any) { console.error('cex_confirm_buy error', e); return ctx.reply(t('cex.internal_error', String(ctx.from?.id))); }
});

bot.action('cex_cancel', async (ctx) => { try { await ctx.reply(t('cex.cancelled', String(ctx.from?.id))); } catch (_) {} });

// Command to set language for a user
bot.command('setlang', async (ctx) => {
  const userId = String(ctx.from?.id);
  const langs = getAvailableLangs();
  const buttons = langs.map(l => Markup.button.callback(l, `setlang_${l}`));
  const rows: any[] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply(t('main_extra.choose_language', String(ctx.from?.id)), { reply_markup: { inline_keyboard: rows } } as any);
});

// Unified handler for setlang callbacks: set language, confirm, and resend updated keyboard
bot.action(/setlang_(.+)/, async (ctx) => {
  const data = String((ctx.callbackQuery as any).data || '');
  const m = data.match(/^setlang_(.+)$/);
  if (!m) return;
  const lang = m[1];
  const userId = String(ctx.from?.id);
  setUserLang(userId, lang);
  try { await ctx.answerCbQuery(); } catch (_) {}
  // reload in-memory users so keyboard builder sees updated data
  try { users = loadUsers(); } catch (_) {}
  try { await ctx.reply(t('common.set_lang_success', userId, { lang })); } catch (_) {}
  try { await ctx.reply(t('main.keyboard_updated', userId), getMainReplyKeyboard(userId)); } catch (_) {}
});

// Admin helpers and commands to manage user languages
function isAdminId(id?: string | number) {
  const raw = (process.env.ADMIN_IDS || process.env.ADMIN_ID || '').toString();
  if (!raw) return false;
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(String(id));
}

bot.command('listusers_lang', async (ctx) => {
  const caller = String(ctx.from?.id);
  if (!isAdminId(caller)) return ctx.reply('❌ Unauthorized');
  const all = loadUsers();
  const lines: string[] = [];
  for (const uid of Object.keys(all)) {
    const u = all[uid] || {};
    lines.push(`${uid}: ${u.lang || 'en'}`);
  }
  if (lines.length === 0) return ctx.reply('No users found');
  // chunk replies to avoid Telegram limits
  for (let i = 0; i < lines.length; i += 30) {
    await ctx.reply(lines.slice(i, i + 30).join('\n'));
  }
});

bot.command('setlang_user', async (ctx) => {
  const caller = String(ctx.from?.id);
  if (!isAdminId(caller)) return ctx.reply('❌ Unauthorized');
  const text = (ctx.message && (ctx.message as any).text) || '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return ctx.reply('Usage: /setlang_user <userId> <lang>');
  const target = parts[1];
  const lang = parts[2];
  const avail = getAvailableLangs();
  if (!avail.includes(lang)) return ctx.reply(`Unknown lang. Available: ${avail.join(',')}`);
  setUserLang(target, lang);
  await ctx.reply(`✅ Set ${target} => ${lang}`);
});

// Admin UI: list users with inline buttons and allow changing language via inline submenu
bot.command('admin_users', async (ctx) => {
  const caller = String(ctx.from?.id);
  if (!isAdminId(caller)) return ctx.reply('❌ Unauthorized');
  const all = loadUsers();
  const rows: any[] = [];
  // build buttons per user (limited to first 50 to avoid huge keyboards)
  const uids = Object.keys(all).slice(0, 200);
  for (let i = 0; i < uids.length; i += 2) {
    const a = uids[i];
    const b = uids[i + 1];
    const row: any[] = [];
    row.push({ text: `${a} (${all[a].lang || 'en'})`, callback_data: `admin_user_${a}` });
    if (b) row.push({ text: `${b} (${all[b].lang || 'en'})`, callback_data: `admin_user_${b}` });
    rows.push(row);
  }
  if (rows.length === 0) return ctx.reply('No users found');
  await ctx.reply('Select a user to manage language:', { reply_markup: { inline_keyboard: rows } } as any);
});

bot.action(/admin_user_(.+)/, async (ctx) => {
  const caller = String(ctx.from?.id);
  if (!isAdminId(caller)) return ctx.reply('❌ Unauthorized');
  const match = String((ctx.callbackQuery as any).data).match(/^admin_user_(.+)$/);
  if (!match) return;
  const target = match[1];
  const usersAll = loadUsers();
  const userObj = usersAll[target] || {};
  const cur = userObj.lang || 'en';
  const langs = getAvailableLangs();
  const rows: any[] = [];
  for (let i = 0; i < langs.length; i += 2) {
    const a = langs[i];
    const b = langs[i + 1];
    const row: any[] = [];
    row.push({ text: `${a}${a===cur? ' ✅' : ''}`, callback_data: `admin_setlang_${target}_${a}` });
    if (b) row.push({ text: `${b}${b===cur? ' ✅' : ''}`, callback_data: `admin_setlang_${target}_${b}` });
    rows.push(row);
  }
  // also provide a cancel button
  rows.push([ { text: 'Cancel', callback_data: 'admin_cancel' } ]);
  // answer the callback and show new message
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.reply(`Manage language for ${target} (current: ${cur})`, { reply_markup: { inline_keyboard: rows } } as any);
});

bot.action(/admin_setlang_(.+)_(.+)/, async (ctx) => {
  const caller = String(ctx.from?.id);
  if (!isAdminId(caller)) return ctx.reply('❌ Unauthorized');
  const data = String((ctx.callbackQuery as any).data);
  const m = data.match(/^admin_setlang_(.+)_(.+)$/);
  if (!m) return;
  const target = m[1];
  const lang = m[2];
  const avail = getAvailableLangs();
  if (!avail.includes(lang)) return ctx.reply('Unknown language');
  setUserLang(target, lang);
  try { await ctx.answerCbQuery('Language updated'); } catch (_) {}
  // reload in-memory users
  try { users = loadUsers(); } catch (_) {}
  await ctx.reply(`✅ Set ${target} => ${lang}`);
  // if target is a numeric chat id, notify them and resend keyboard so their labels update
  if (/^\d+$/.test(String(target))) {
    try {
      await bot.telegram.sendMessage(Number(target), t('common.set_lang_success', target, { lang }));
      await bot.telegram.sendMessage(Number(target), t('main.keyboard_updated', target), getMainReplyKeyboard(target));
    } catch (_) {}
  }
});

bot.action('admin_cancel', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  try { await ctx.reply('Cancelled'); } catch (_) {}
});

// Central text router: map translated reply-keyboard labels to handlers so buttons work immediately after language change
bot.on('text', async (ctx, next) => {
  const text = String((ctx.message && (ctx.message as any).text) || '');
  const userId = String(ctx.from?.id);
  // wallet
  if (matchesLabel(text, 'main.wallet', userId)) {
    console.log(`[💼 Wallet menu] User: ${userId}`);
    const user = users[userId];
    const has = user && hasWallet(user);
    const buttons: any[] = [];
  if (has) buttons.push([ { text: t('common.show_wallet', userId), callback_data: 'show_secret_inline' } ]);
    buttons.push([ { text: has ? t('common.change_wallet', userId) : t('common.create_wallet', userId), callback_data: 'create_or_change_wallet_inline' } ]);
    buttons.push([ { text: t('common.restore_wallet', userId), callback_data: 'restore_wallet_inline' } ]);
    await ctx.reply(t('main.wallet', userId) + ' ' + t('main.settings', userId));
    return await ctx.reply(t('common.wallet_options', userId), { reply_markup: { inline_keyboard: buttons } } as any);
  }
  // strategy
  if (matchesLabel(text, 'main.strategy', userId)) {
    console.log(`[⚙️ Strategy] User: ${String(ctx.from?.id)}`);
    userStrategyStates[userId] = { step: 0, values: {} };
    await ctx.reply(t('strategy.setup_intro', userId));
    // If no STRATEGY_FIELDS are defined (we only want trade-level settings),
    // jump directly to trade settings phase and prompt for buy amount.
    if (!STRATEGY_FIELDS || STRATEGY_FIELDS.length === 0) {
      userStrategyStates[userId].phase = 'tradeSettings';
      userStrategyStates[userId].step = 0;
      userStrategyStates[userId].tradeSettings = {};
      await ctx.reply('⚙️ Trade settings:\nPlease enter the buy amount per trade (SOL):');
      return;
    }
    const field = STRATEGY_FIELDS[0];
    return await ctx.reply(t('strategy.field_prompt', userId, { label: field.label, optional: field.optional ? ' (optional)' : '' }));
  }
  // show tokens
  if (matchesLabel(text, 'main.show_tokens', userId)) {
    console.log(`[📊 Show Tokens] User: ${String(ctx.from?.id)}`);
    return ctx.reply(t('main.show_tokens_help', userId));
  }
  // invite friends
  if (matchesLabel(text, 'main.invite_friends', userId)) {
    console.log(`[🤝 Invite Friends] User: ${String(ctx.from?.id)}`);
    const inviteLink = `https://t.me/${ctx.me}?start=${userId}`;
    return ctx.reply(t('main.invite_friends_msg', userId, { link: inviteLink }));
  }
  // language button
  if (matchesLabel(text, 'main.language', userId)) {
    const langs = getAvailableLangs();
    const buttons = langs.map(l => Markup.button.callback(l, `setlang_${l}`));
    const rows: any[] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    return ctx.reply(t('main_extra.choose_language', userId), { reply_markup: { inline_keyboard: rows } } as any);
  }
  // Sniper CEX button — match exact translated label only
  if (matchesLabel(text, 'main.sniper_cex', userId)) {
    // delegate to existing handler by calling it inline: emulate the previous behavior
    // Prefer private chat for sharing secrets
      try {
      const chatType = (ctx.chat && (ctx.chat as any).type) || '';
      if (chatType !== 'private') {
        await ctx.reply(t('cex.private_chat_required', userId));
        return;
      }
  users = loadUsers();
      const have = users[userId] && users[userId].cex ? 'You already have keys saved. Sending new keys will require CONFIRM to overwrite.' : '';
      // Show inline submenu for CEX sniper controls (start/stop/status/history/change keys)
      const rows: any[] = [];
      rows.push([
        { text: '▶️ ' + t('cex.start_sniper', userId), callback_data: 'cex_start' },
        { text: '⏹️ ' + t('cex.stop_sniper', userId), callback_data: 'cex_stop' }
      ]);
      rows.push([
        { text: '📊 ' + t('cex.status', userId), callback_data: 'cex_status' },
        { text: '📜 ' + t('cex.history', userId), callback_data: 'cex_history' }
      ]);
      rows.push([
        { text: '🔑 ' + t('cex.change_keys', userId), callback_data: 'cex_change_keys' }
      ]);
      // Add Request Tokens and Enable Live Trading buttons
      rows.push([
        { text: '🧾 ' + t('cex.menu_request_tokens', userId), callback_data: 'cex_request_tokens' },
        { text: '⚡ ' + t('cex.menu_enable_live', userId), callback_data: 'cex_enable_live' }
      ]);
      return await ctx.reply(t('cex.prompt_enter_keys', userId, { have: have, after: users[userId] && users[userId].cex ? tForLang('cex.already_have_keys', (users[userId] && users[userId].lang) || 'en') : tForLang('cex.api_keys_saved', (users[userId] && users[userId].lang) || 'en') }), { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' } as any);
    } catch (e) {
      console.error('[Sniper-CEX] handler error', e);
      try { return await ctx.reply('❌ Failed to start CEX key prompt.'); } catch (_) { return; }
    }
  }
  // DEX Sniper: match the translated label exactly
  if (matchesLabel(text, 'main.sniper', userId)) {
    await handleSniper(ctx, undefined);
    return;
  }
  // otherwise let other handlers run
  if (typeof next === 'function') return next();
  return;
});

// Inline handlers for the wallet submenu
bot.action('show_secret_inline', async (ctx) => {
  const userId = String(ctx.from?.id);
  users = loadUsers();
  const user = users[userId];
  if (user && hasWallet(user)) {
    // show masked secret and provide button to reveal in private chat
    const secret = String(user.secret || '');
    const masked = secret ? (secret.length > 12 ? (secret.slice(0,6) + '...' + secret.slice(-6)) : ('***' + secret.slice(-6))) : 'N/A';
    await ctx.reply(t('common.show_full_key_private_only', userId, { masked }), { parse_mode: 'HTML' } as any);
    await ctx.reply(t('common.reveal_prompt', userId), { reply_markup: { inline_keyboard: [ [ { text: '🔐 ' + t('common.reveal_prompt', userId), callback_data: 'reveal_full_secret' } ] ] } } as any);
  } else {
    await ctx.reply(t('common.no_wallet', userId));
  }
});

bot.action('reveal_full_secret', async (ctx) => {
  const chatType = (ctx.chat && (ctx.chat as any).type) || '';
  const userId = String(ctx.from?.id);
  users = loadUsers();
  const user = users[userId];
  if (chatType !== 'private') {
    return ctx.reply(t('common.reveal_private_only', userId));
  }
  if (user && hasWallet(user)) {
    await ctx.reply(t('common.full_private_key', userId, { secret: user.secret }), { parse_mode: 'HTML' });
  } else {
    await ctx.reply(t('common.no_wallet', userId));
  }
});

// === CEX sniper callback handlers ===
bot.action('cex_start', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    const keys = await cryptoGetUserKeys(userId);
    if (!keys) return ctx.reply(t('cex.no_keys_saved', userId));
    // dynamic require so module is optional
    const cex = require('./cexSniper.js');
    const res = await cex.startUserCexSniper(userId, { apiKey: keys.apiKey, apiSecret: keys.apiSecret, platform: (users[userId] && users[userId].cex && users[userId].cex.platform) || 'BINANCE' }, {});
    return ctx.reply(res && res.ok ? t('cex.sniper_started', userId) : t('cex.sniper_start_failed', userId, { err: res && res.err ? String(res.err) : 'unknown' }));
  } catch (e: any) { console.error('cex_start error', e); return ctx.reply(t('cex.sniper_start_failed', userId, { err: (e && e.message) || String(e) })); }
});

bot.action('cex_stop', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    const cex = require('./cexSniper.js');
    const res = await cex.stopUserCexSniper(userId);
    return ctx.reply(res && res.ok ? t('cex.sniper_stopped', userId) : t('cex.sniper_stop_failed', userId, { err: res && res.err ? String(res.err) : 'unknown' }));
  } catch (e: any) { console.error('cex_stop error', e); return ctx.reply(t('cex.sniper_stop_failed', userId, { err: (e && e.message) || String(e) })); }
});

bot.action('cex_status', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    const cex = require('./cexSniper.js');
    const res = await cex.getUserCexSniperStatus(userId);
    if (!res || !res.ok) return ctx.reply(t('cex.sniper_status_failed', userId, { err: res && res.err ? String(res.err) : 'unknown' }));
    if (res.running) return ctx.reply(t('cex.sniper_running_since', userId, { since: new Date(res.since).toLocaleString() }));
    return ctx.reply(t('cex.sniper_not_running', userId));
  } catch (e: any) { console.error('cex_status error', e); return ctx.reply(t('cex.sniper_status_failed', userId, { err: (e && e.message) || String(e) })); }
});

bot.action('cex_history', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    const cex = require('./cexSniper.js');
    const res = await cex.getUserTradeHistory(userId);
    if (!res || !res.ok) return ctx.reply(t('cex.history_failed', userId, { err: res && res.err ? String(res.err) : 'unknown' }));
    const lines = (res.trades || []).slice(-20).reverse().map((r: any) => {
      const ts = r.ts ? new Date(r.ts).toLocaleString() : 'n/a';
      return `${ts} ${r.side||r.action||''} ${r.symbol||''} ${r.size?('size='+r.size):''} ${r.note?r.note:''}`.trim();
    });
    if (lines.length === 0) return ctx.reply(t('cex.no_history', userId));
    // chunk replies
    for (let i = 0; i < lines.length; i += 20) await ctx.reply(lines.slice(i, i + 20).join('\n'));
    return;
  } catch (e: any) { console.error('cex_history error', e); return ctx.reply(t('cex.history_failed', userId, { err: (e && e.message) || String(e) })); }
});

bot.action('cex_change_keys', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    // Reuse the existing flow: mark expecting set and instruct user to paste keys
    const expecting = (globalThis as any).__expectingCexKeys as Set<string>;
    expecting.add(userId);
    return ctx.reply(t('cex.prompt_enter_keys', userId));
  } catch (e: any) { console.error('cex_change_keys error', e); return ctx.reply(t('cex.api_keys_save_failed', userId)); }
});

// Show submenu for token requests (analysis / trade request)
bot.action('cex_request_tokens', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    // Clear any pending CEX key expectations so token input won't be misinterpreted
    try { (globalThis as any).__expectingCexKeys && (globalThis as any).__expectingCexKeys.delete(userId); } catch (_) {}
    try { (globalThis as any).__pendingPartial && (globalThis as any).__pendingPartial.delete(userId); } catch (_) {}
    const rows: any[] = [];
    rows.push([
      { text: '🔎 ' + t('cex.menu_analyze_token', userId), callback_data: 'cex_analyze_token' },
      { text: '📩 ' + t('cex.menu_request_trades', userId), callback_data: 'cex_request_trades' }
    ]);
    rows.push([ { text: '⬅️ ' + t('cex.menu_back', userId), callback_data: 'cex_back' } ]);
    return await ctx.reply('اختر إجراء لطلب العملات:', { reply_markup: { inline_keyboard: rows } } as any);
  } catch (e: any) { console.error('cex_request_tokens error', e); return ctx.reply('خطأ داخلي'); }
});

// Analyze token stub — asks user to send token symbol or address for analysis
bot.action('cex_analyze_token', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    // Ensure we are not in key-entry mode
    try { (globalThis as any).__expectingCexKeys && (globalThis as any).__expectingCexKeys.delete(userId); } catch (_) {}
    try { (globalThis as any).__pendingPartial && (globalThis as any).__pendingPartial.delete(userId); } catch (_) {}
    (globalThis as any).__expectingCexTokenAnalysis.add(userId);
      return ctx.reply(t('cex.prompt_send_token', userId));
  } catch (e: any) { console.error('cex_analyze_token error', e); return ctx.reply('خطأ داخلي'); }
});

// Request trades stub — asks user to send trade request details
bot.action('cex_request_trades', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
  // Ensure we are not in key-entry mode
  try { (globalThis as any).__expectingCexKeys && (globalThis as any).__expectingCexKeys.delete(userId); } catch (_) {}
  try { (globalThis as any).__pendingPartial && (globalThis as any).__pendingPartial.delete(userId); } catch (_) {}
  (globalThis as any).__expectingCexTradeRequest.add(userId);
  return ctx.reply(t('cex.prompt_send_trade', userId));
  } catch (e: any) { console.error('cex_request_trades error', e); return ctx.reply('خطأ داخلي'); }
});

// Enable live trading handler — will start cexSniper in live-mode (record only, no real orders)
bot.action('cex_enable_live', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    const keys = await cryptoGetUserKeys(userId);
    if (!keys) return ctx.reply(t('cex.no_keys_saved', userId));
    const cex = require('./cexSniper.js');
    const res = await cex.startUserCexSniper(userId, { apiKey: keys.apiKey, apiSecret: keys.apiSecret, platform: (users[userId] && users[userId].cex && users[userId].cex.platform) || 'BINANCE' }, { live: true });
    if (res && res.ok) {
      return ctx.reply(t('cex.live_enabled', userId));
    }
    return ctx.reply(t('cex.live_enable_failed', userId, { err: (res && res.err ? String(res.err) : 'unknown') }));
  } catch (e: any) { console.error('cex_enable_live error', e); return ctx.reply('خطأ أثناء تفعيل التداول الحي: ' + (e && e.message ? e.message : String(e))); }
});

// Simple back handler to re-open main CEX submenu
bot.action('cex_back', async (ctx) => {
  const userId = String(ctx.from?.id);
  try {
    // Rebuild the same submenu used when opening Sniper CEX
    users = loadUsers();
    const rows: any[] = [];
    rows.push([
      { text: '▶️ ' + t('cex.start_sniper', userId), callback_data: 'cex_start' },
      { text: '⏹️ ' + t('cex.stop_sniper', userId), callback_data: 'cex_stop' }
    ]);
    rows.push([
      { text: '📊 ' + t('cex.status', userId), callback_data: 'cex_status' },
      { text: '📜 ' + t('cex.history', userId), callback_data: 'cex_history' }
    ]);
    rows.push([
      { text: '🔑 ' + t('cex.change_keys', userId), callback_data: 'cex_change_keys' }
    ]);
    rows.push([
      { text: '🧾 ' + t('cex.menu_request_tokens', userId), callback_data: 'cex_request_tokens' },
      { text: '⚡ ' + t('cex.menu_enable_live', userId), callback_data: 'cex_enable_live' }
    ]);
    return ctx.reply(t('cex.prompt_enter_keys', userId, { have: '', after: '' }), { reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' } as any);
  } catch (e: any) { console.error('cex_back error', e); return ctx.reply(t('cex.internal_error', userId)); }
});

bot.action('create_or_change_wallet_inline', async (ctx) => {
  const userId = String(ctx.from?.id);
  users = loadUsers();
  let user = users[userId] || {};
  // If user already has a wallet, ask confirmation via message then proceed to create (for now create immediately)
  if (user.secret && user.wallet) {
    // Overwrite with a new generated wallet
    const keypair = generateKeypair();
    const secret = exportSecretKey(keypair);
    // preserve existing wallet into wallets array, then set new as active
    user.wallets = user.wallets || [];
    try { user.wallets.push({ wallet: user.wallet, secret: user.secret, createdAt: Date.now() }); } catch (_) {}
    user.secret = secret;
    user.wallet = keypair.publicKey?.toBase58?.() || keypair.publicKey;
    try { user.wallets.push({ wallet: user.wallet, secret: user.secret, createdAt: Date.now() }); } catch (_) {}
    users[userId] = user;
    saveUsers(users);
  await ctx.reply(t('common.wallet_changed', userId, { address: escapeHtml(user.wallet) }), { parse_mode: 'HTML' });
    return;
  }
  // Create new wallet
  const keypair = generateKeypair();
  const secret = exportSecretKey(keypair);
  user.secret = secret;
  const newWalletAddr = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  user.wallet = newWalletAddr;
  user.wallets = user.wallets || [];
  try { user.wallets.push({ wallet: newWalletAddr, secret, createdAt: Date.now() }); } catch (_) {}
  users[userId] = user;
  saveUsers(users);
  await ctx.reply(t('common.wallet_created', userId, { address: escapeHtml(user.wallet) }), { parse_mode: 'HTML' });
});

bot.action('restore_wallet_inline', async (ctx) => {
  const userId = String(ctx.from?.id);
  restoreStates[userId] = true;
  await ctx.reply(t('common.restore_prompt_private', userId));
});

bot.action('show_secret', async (ctx) => {
  console.log(`[show_secret] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
    const secret = String(user.secret || '');
    const masked = secret ? (secret.length > 12 ? (secret.slice(0,6) + '...' + secret.slice(-6)) : ('***' + secret.slice(-6))) : 'N/A';
    await ctx.reply(t('common.show_full_key_private_only', userId, { masked }), { parse_mode: 'HTML' });
    await ctx.reply(t('common.reveal_prompt', userId), { reply_markup: { inline_keyboard: [ [ { text: '🔐 ' + t('common.reveal_prompt', userId), callback_data: 'reveal_full_secret' } ] ] } } as any);
  } else {
    await ctx.reply(t('common.no_wallet', userId));
  }
});



// Sniper handler extracted to function so it can be invoked from router (supports counts)
async function handleSniper(ctx: any, explicitCount?: number) {
  console.log(`[Sniper] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId] = users[userId] || {};
  let maxCollect = 3;
  try {
    if (explicitCount && !isNaN(Number(explicitCount)) && Number(explicitCount) > 0) {
      maxCollect = Math.max(1, Math.min(20, Math.floor(Number(explicitCount))));
    } else {
      const v = user.listenerMaxCollect || (user.strategy && (user.strategy.listenerMaxCollect || user.strategy.maxCollect || user.strategy.maxTrades));
      const n = Number(v);
      if (!isNaN(n) && n > 0) maxCollect = Math.max(1, Math.min(20, Math.floor(n)));
    }
  } catch (e) {}
  const timeoutMs = Number(process.env.RUNNER_TIMEOUT_MS || 60000);
  await ctx.reply(t('sniper.fetching', userId, { n: String(maxCollect) }));
  try{
    const sniperMod = require('./sniper.js');
    if(!sniperMod || typeof sniperMod.collectFreshMints !== 'function'){
      await ctx.reply(t('sniper.collect_func_missing', userId));
      return;
    }
    console.error(`[Sniper] request user=${userId} maxCollect=${maxCollect} timeoutMs=${timeoutMs}`);
    let res = await sniperMod.collectFreshMints({ maxCollect, timeoutMs });
    console.error(`[Sniper] initial resultCount=${(res && Array.isArray(res)) ? res.length : 'err'}`);
      if(!res || !Array.isArray(res) || res.length===0){
      const retryTimeout = Math.min(Number(process.env.RUNNER_TIMEOUT_MS || 60000) * 2, 120000);
      console.error(`[Sniper] initial empty - retrying with timeoutMs=${retryTimeout} for user=${userId}`);
      try{ await ctx.reply(t('sniper.retrying', userId)); } catch(_) {}
      res = await sniperMod.collectFreshMints({ maxCollect, timeoutMs: retryTimeout });
      console.error(`[Sniper] retry resultCount=${(res && Array.isArray(res)) ? res.length : 'err'}`);
      if(!res || !Array.isArray(res) || res.length===0){
        await ctx.reply(t('sniper.no_mints', userId));
        return;
      }
    }
    // Build and send messages
    try {
      const botUsername = bot.botInfo?.username || process.env.BOT_USERNAME || 'YourBotUsername';
      users = loadUsers();
      const userObj = users && users[userId] ? users[userId] : {};
      const limit = Math.min(maxCollect, Array.isArray(res) ? res.length : 0);
      let combinedMsg = '';
      const combinedKeyboard: any[] = [];
      const botUsernameSafe = escapeHtml(botUsername || String(process.env.BOT_USERNAME || ''));
    for (let i = 0; i < limit; i++) {
        const tok = res[i];
        try {
          const mint = tok && (tok.tokenAddress || tok.address || tok.mint) ? (tok.tokenAddress || tok.address || tok.mint) : String(tok);
          const name = tok && (tok.name || tok.symbol) ? escapeHtml(tok.name || tok.symbol) : escapeHtml(mint);
          const priceSol = tok && (tok.priceSol || tok.price || tok.priceUsd) ? String(tok.priceSol || tok.price || tok.priceUsd) : '-';
          if (combinedMsg) combinedMsg += '\n';
          combinedMsg += `• <b>${name}</b> — <code>${escapeHtml(mint)}</code> — <i>${escapeHtml(priceSol)}</i>`;
          const deepLink = `https://t.me/${botUsernameSafe}?start=share_${encodeURIComponent(String(userId))}_${encodeURIComponent(String(mint))}`;
          const shareText = encodeURIComponent(`${name} - ${mint}\n${deepLink}`);
          const shareUrl = `https://t.me/share/url?text=${shareText}`;
          const row: any[] = [
            { text: '🛒 ' + t('buy.button', userId), callback_data: `buy_${mint}` },
            { text: '🔻 ' + t('sell.button', userId), callback_data: `sell_${mint}` },
            { text: '🔗 ' + t('common.share', userId), url: shareUrl }
          ];
          combinedKeyboard.push(row);
        } catch (err) {
          console.error('[Sniper->build] token build failed', err);
        }
      }
      if (combinedMsg) {
        try {
          const replyMarkup: any = { inline_keyboard: combinedKeyboard };
          await bot.telegram.sendMessage(Number(userId) || userId, combinedMsg, { parse_mode: 'HTML', reply_markup: replyMarkup } as any);
        } catch (sendErr) {
          try { await ctx.replyWithHTML(`<pre>${escapeHtml(JSON.stringify(res, null, 2))}</pre>`, { disable_web_page_preview: true } as any); } catch (e2) { console.error('[Sniper->send] final fallback failed', e2); }
        }
      } else {
        try { await ctx.replyWithHTML(`<pre>${escapeHtml(JSON.stringify(res, null, 2))}</pre>`, { disable_web_page_preview: true } as any); } catch (e) { console.error('[Sniper->send] fallback failed', e); }
      }
      (async () => {
        try {
          const tokensToHandle = res.slice(0, limit).map((tok: any) => ({ mint: tok.tokenAddress || tok.address || tok.mint || tok.pairAddress || String(tok), createdAt: tok.firstBlockTime || tok.firstBlock || null, __listenerCollected: true, ledgerMask: tok.ledgerMask, ledgerStrong: tok.ledgerStrong, solletCreatedHere: tok.solletCreatedHere, mergedSignal: tok.mergedSignal }));
          // Determine whether to perform an immediate live buy: require user opt-in and explicit env enable for safety
          const userOptIn = !!(userObj && userObj.strategy && userObj.strategy.autoBuy === true);
          const envAllow = String(process.env.ENABLE_IMMEDIATE_SNIPER_BUY || 'false').toLowerCase() === 'true';
          const simulateOnly = !(userOptIn && envAllow);
          await autoExecuteStrategyForUser(userObj, tokensToHandle, 'buy', { simulateOnly, listenerBypass: true });
        } catch (bgErr) { console.error('[Sniper->autoExec background error]', bgErr ? (bgErr instanceof Error ? bgErr.message : String(bgErr)) : 'unknown'); }
      })();
      return;
      } catch (e: any) {
      console.error('[Sniper->send] background-sim handler failed', e ? (e instanceof Error ? e.message : String(e)) : 'unknown');
      try { await ctx.reply(t('common.error_processing_results', userId)); } catch (_) {}
    }
  } catch (e) {
    console.error('Sniper collector error', (e as any) && (e as any).message || e);
    try{ await ctx.reply(t('common.error_fetching_mints', userId)); }catch(_){ }
  }
}

// Allow users to set preferred number of mints returned by the button
bot.command('set_mints', async (ctx) => {
  const userId = String(ctx.from?.id);
  const parts = ctx.message.text.split(' ').map(s=>s.trim()).filter(Boolean);
  if(parts.length < 2){
    await ctx.reply(t('commands.set_mints_usage', userId));
    return;
  }
  const n = Number(parts[1]);
  if(isNaN(n) || n <= 0 || n > 20){
    await ctx.reply(t('commands.invalid_number', userId));
    return;
  }
  users[userId] = users[userId] || {};
  users[userId].listenerMaxCollect = n;
  saveUsers(users);
  await ctx.reply(t('commands.mints_set', userId, { n: String(n) }));
});

bot.command('notify_tokens', async (ctx) => {
  console.log(`[notify_tokens] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (!user || !user.strategy || !user.strategy.enabled) {
    await ctx.reply(t('common_extra.no_strategy_or_wallet', userId));
    return;
  }
  const now = Date.now();
  if (!globalTokenCache.length || now - lastCacheUpdate > CACHE_TTL) {
    globalTokenCache = await fetchDexScreenerTokens('solana');
    lastCacheUpdate = now;
  }
  const filteredTokens = filterTokensByStrategy(globalTokenCache, user.strategy);
  if (!filteredTokens.length) {
    await ctx.reply(t('main.no_tokens_match', userId));
    return;
  }
  await notifyUsers(ctx.telegram, { [userId]: user }, filteredTokens);
  await ctx.reply(t('main.notifications_sent', userId));
});



bot.action(/buy_(.+)/, async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[buy] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply(t('common_extra.no_strategy_or_wallet', userId));
    return;
  }
  try {
    const amount = Number(user.strategy && user.strategy.buyAmount);
    if (!amount || isNaN(amount) || amount <= 0) {
      await ctx.reply(t('buy.invalid_buy_amount', userId), { parse_mode: 'Markdown' });
      return;
    }
    await ctx.reply(t('buy.buying_token', userId, { token: tokenAddress, amount: String(amount) }), { parse_mode: 'HTML' });
      let result: any;
      try {
        result = await unifiedBuy(tokenAddress, amount, user.secret);
      } catch (err: any) {
        const msg = err && err.message ? String(err.message) : String(err);
        await ctx.reply(t('buy.purchase_cancelled', userId, { msg }));
        console.error('buy error:', err);
        return;
      }
      const txSig = extractTx(result);
    if (txSig) {
      if (!boughtTokens[userId]) boughtTokens[userId] = new Set();
      boughtTokens[userId].add(tokenAddress);
      const entry = `ManualBuy: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedBuy | Tx: ${txSig}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      registerBuyWithTarget(user, { address: tokenAddress }, result, user.strategy.targetPercent || 10);
      await ctx.reply(t('buy.success', userId, { percent: String(user.strategy.targetPercent || 10) }));
    } else {
      await ctx.reply(t('buy.failed_tx', userId));
    }
  } catch (e) {
    await ctx.reply(t('buy.error', userId, { err: getErrorMessage(e) }));
    console.error('buy error:', e);
  }
});



async function getUserTokenBalance(user: any, tokenAddress: string): Promise<number> {
  if (user && user.balances && typeof user.balances[tokenAddress] === 'number') {
    return user.balances[tokenAddress];
  }
  return user.strategy.buyAmount || 0.01;
}


bot.action(/sell_(.+)/, async (ctx: any) => {
  const userId = String(ctx.from?.id);
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[sell] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply(t('common_extra.no_strategy_or_wallet', userId));
    return;
  }
  try {
    const sellPercent = user.strategy.sellPercent1 || 100;
    const balance = await getUserTokenBalance(user, tokenAddress);
    const amount = (balance * sellPercent) / 100;
  await ctx.reply(t('sell.selling_token', userId, { token: tokenAddress, percent: String(sellPercent), balance: String(balance) }), { parse_mode: 'HTML' });
    const result = await unifiedSell(tokenAddress, amount, user.secret);
    const sellTx = extractTx(result);
    if (sellTx) {
      const entry = `ManualSell: ${tokenAddress} | Amount: ${amount} | Source: unifiedSell | Tx: ${sellTx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply(t('sell.success', userId));
    } else {
      await ctx.reply(t('sell.failed_tx', userId));
    }
  } catch (e: any) {
    await ctx.reply(t('sell.error', userId, { err: getErrorMessage(e) }));
    console.error('sell error:', e);
  }
});


bot.command('wallet', async (ctx) => {
  console.log(`[wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  const user = users[userId];
  if (user && hasWallet(user)) {
    const secret = String(user.secret || '');
    const masked = secret ? (secret.length > 12 ? (secret.slice(0,6) + '...' + secret.slice(-6)) : ('***' + secret.slice(-6))) : 'N/A';
    await ctx.reply(t('wallet_msgs.masked_message', userId, { masked }), walletKeyboard());
  } else {
    await ctx.reply(t('wallet_msgs.no_wallet_found', userId), walletKeyboard());
  }
});


bot.command(['create_wallet', 'restore_wallet'], async (ctx) => {
  console.log(`[${ctx.message.text.startsWith('/restore_wallet') ? 'restore_wallet' : 'create_wallet'}] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
  let keypair, secret;
  if (ctx.message.text.startsWith('/restore_wallet')) {
    const parts = ctx.message.text.split(' ');
    if (parts.length < 2) {
      await ctx.reply('❗ Please provide the private key after the command. Example: /restore_wallet <secret>');
      return;
    }
    try {
      keypair = parseKey(parts[1]);
      secret = exportSecretKey(keypair);
    } catch (e) {
      await ctx.reply('❌ Failed to restore wallet. Invalid key.');
      return;
    }
  } else {
    keypair = generateKeypair();
    secret = exportSecretKey(keypair);
  }
  user.secret = secret;
  const newWalletAddr = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  user.wallet = newWalletAddr;
  user.wallets = user.wallets || [];
  try { user.wallets.push({ wallet: newWalletAddr, secret, createdAt: Date.now() }); } catch (_) {}
  saveUsers(users);
  await ctx.reply('✅ Wallet ' + (ctx.message.text.startsWith('/restore_wallet') ? 'restored' : 'created') + ' successfully!\nAddress: <code>' + user.wallet + '</code>\nPrivate key (keep it safe): <code>' + user.secret + '</code>', { parse_mode: 'HTML' });
});


async function notifyAutoSell(user: any, sellOrder: any) {
  console.log(`[notifyAutoSell] User: ${user?.id || user?.userId || user?.telegramId}, Token: ${sellOrder.token}, Amount: ${sellOrder.amount}, Status: ${sellOrder.status}`);
  try {
    const chatId = user.id || user.userId || user.telegramId;
    let msg = `✅ Auto-sell order executed:\n`;
    msg += `Token: ${sellOrder.token}\nAmount: ${sellOrder.amount}\nTarget price: ${sellOrder.targetPrice}\n`;
    msg += sellOrder.tx ? `Transaction: ${sellOrder.tx}\n` : '';
    msg += sellOrder.status === 'success' ? 'Executed successfully.' : 'Execution failed.';
    await bot.telegram.sendMessage(chatId, msg);
  } catch {}
}

setInterval(async () => {
  console.log(`[monitorAndAutoSellTrades] Interval triggered`);
  if (!globalTokenCache || !Array.isArray(globalTokenCache)) return;
  if (!users || typeof users !== 'object') return;
  const tokens = globalTokenCache;
  for (const userId in users) {
    if (!userId || userId === 'undefined') {
      console.warn('[monitorAndAutoSellTrades] Invalid userId, skipping.');
      continue;
    }
    const user = users[userId];
    await monitorAndAutoSellTrades(user, tokens);
    const sentTokensDir = process.cwd() + '/sent_tokens';
    const userFile = `${sentTokensDir}/${userId}.json`;
    if (!require('fs').existsSync(userFile)) continue;
    let userTrades = [];
    try { userTrades = JSON.parse(require('fs').readFileSync(userFile, 'utf8')); } catch {}
    const executed = userTrades.filter((t: any) => t.mode === 'sell' && t.status === 'success' && t.auto && !t.notified);
    for (const sellOrder of executed) {
      await notifyAutoSell(user, sellOrder);
      (sellOrder as any).notified = true;
    }
    require('fs').writeFileSync(userFile, JSON.stringify(userTrades, null, 2));
  }
}, 5 * 60 * 1000);


// ========== Interactive wallet buttons ==========
bot.action('create_wallet', async (ctx) => {
  console.log(`[create_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  let user = users[userId];
  if (!user) {
    user = {};
    users[userId] = user;
  }
    // Prevent creating a wallet if one already exists
    if (user.secret && user.wallet) {
      await ctx.reply('You already have a wallet! You can view it from the menu.');
      return;
  }
  const keypair = generateKeypair();
  const secret = exportSecretKey(keypair);
  user.secret = secret;
  const newWalletAddr = keypair.publicKey?.toBase58?.() || keypair.publicKey;
  user.wallet = newWalletAddr;
  user.wallets = user.wallets || [];
  try { user.wallets.push({ wallet: newWalletAddr, secret, createdAt: Date.now() }); } catch (_) {}
  saveUsers(users);
  await ctx.reply(`✅ Wallet created successfully!\nAddress: <code>${user.wallet}</code>\nPrivate key (keep it safe): <code>${user.secret}</code>`, { parse_mode: 'HTML' });
});

bot.action('restore_wallet', async (ctx) => {
  console.log(`[restore_wallet] User: ${String(ctx.from?.id)}`);
  const userId = String(ctx.from?.id);
  restoreStates[userId] = true;
  await ctx.reply(t('common.restore_prompt_private', userId));
});

bot.on('text', async (ctx, next) => {
  console.log(`[text] User: ${String(ctx.from?.id)}, Message: ${ctx.message.text}`);
  const userId = String(ctx.from?.id);
  if (restoreStates[userId]) {
    const secret = ctx.message.text.trim();
    try {
      const keypair = parseKey(secret);
      let user = users[userId] || {};
      const exported = exportSecretKey(keypair);
      const walletAddr = keypair.publicKey?.toBase58?.() || keypair.publicKey;
      user.secret = exported;
      user.wallet = walletAddr;
      user.wallets = user.wallets || [];
      try { user.wallets.push({ wallet: walletAddr, secret: exported, createdAt: Date.now() }); } catch (_) {}
      users[userId] = user;
      saveUsers(users);
      delete restoreStates[userId];

  await ctx.reply(t('common.wallet_restored_success', userId, { address: user.wallet, secret: user.secret }), { parse_mode: 'HTML' });
          } catch {
    await ctx.reply(t('common.restore_failed_invalid', userId));
          }
          return;
        }
        if (typeof next === 'function') return next();
      });

      const userStrategyStates: Record<string, { step: number, values: Record<string, any>, phase?: string, tradeSettings?: Record<string, any> }> = {};

      // Strategy flow is handled by the central text router above; no duplicate hears here.

      bot.on('text', async (ctx, next) => {
        const userId = String(ctx.from?.id);
        if (userStrategyStates[userId]) {
          const state = userStrategyStates[userId];
          if (state.phase === 'tradeSettings') {
            // Only collect buy amount (SOL) and sell percent (first target).
            const tradeFields = [
                { key: 'buyAmount', label: 'Buy amount per trade (SOL)', type: 'number' },
                { key: 'sellPercent1', label: 'Sell percent for first target (%)', type: 'number' }
              ];
            if (state.step >= tradeFields.length) {
              delete userStrategyStates[userId];
              return;
            }
            const current = tradeFields[state.step];
            let value: any = ctx.message.text.trim();
            const numValue = Number(value);
            if (isNaN(numValue)) {
              await ctx.reply('❗ Please enter a valid number.');
              return;
            }
            value = numValue;
            if (!state.tradeSettings) state.tradeSettings = {};
            state.tradeSettings[current.key] = value;
            state.step++;
            if (state.step < tradeFields.length) {
              await ctx.reply(`📝 ${tradeFields[state.step].label}`);
            } else {
              if (!users[userId]) users[userId] = {};
              users[userId].strategy = { ...state.values, ...state.tradeSettings, enabled: true };
              saveUsers(users);
              delete userStrategyStates[userId];
              await ctx.reply('✅ Strategy and trade settings saved successfully! You can now press "📊 Show Tokens" to see matching tokens and trades.');
            }
            return;
          }
          if (state.step >= STRATEGY_FIELDS.length) {
            delete userStrategyStates[userId];
            return;
          }
          const field = STRATEGY_FIELDS[state.step];
          let value: any = ctx.message.text.trim();
          if (value === 'skip' && field.optional) {
            value = undefined;
          } else if (field.type === 'number') {
            const numValue = Number(value);
            if (isNaN(numValue)) {
              await ctx.reply('❗ Please enter a valid number.');
              return;
            }
            value = numValue;
          }
          state.values[field.key] = value;
          state.step++;
          if (state.step < STRATEGY_FIELDS.length) {
            const nextField = STRATEGY_FIELDS[state.step];
            await ctx.reply(`📝 ${nextField.label}${nextField.optional ? ' (optional)' : ''}`);
          } else {
            state.step = 0;
            state.phase = 'tradeSettings';
            state.tradeSettings = {};
            await ctx.reply('⚙️ Trade settings:\nPlease enter the buy amount per trade (SOL):');
          }
          return;
        }
        if (typeof next === 'function') return next();
      });

      bot.command('show_token', async (ctx) => {
  console.log(`[show_token] User: ${String(ctx.from?.id)}`);
        const userId = String(ctx.from?.id);
        const user = users[userId];
        if (!user || !user.strategy || !user.strategy.enabled) {
          await ctx.reply('❌ You must set a strategy first using /strategy');
          return;
        }
        const now = Date.now();
        if (!globalTokenCache.length || now - lastCacheUpdate > CACHE_TTL) {
          globalTokenCache = await fetchDexScreenerTokens('solana');
          lastCacheUpdate = now;
        }
        const filteredTokens = filterTokensByStrategy(globalTokenCache, user.strategy);
        const maxTrades = user.strategy.maxTrades && user.strategy.maxTrades > 0 ? user.strategy.maxTrades : 5;
        const tokensToTrade = filteredTokens.slice(0, maxTrades);
        if (!tokensToTrade.length) {
          await ctx.reply('No tokens currently match your strategy.');
          return;
        }
        await ctx.reply(`🔎 Found <b>${tokensToTrade.length}</b> tokens matching your strategy${filteredTokens.length > maxTrades ? ` (showing first ${maxTrades})` : ''}.\nExecuting auto-buy and auto-sell setup...`, { parse_mode: 'HTML' });

        let buyResults: string[] = [];
        let successCount = 0, failCount = 0;
        for (const token of tokensToTrade) {
          const tokenAddress = token.tokenAddress || token.address || token.mint || token.pairAddress;
          const buyAmount = user.strategy.buyAmount || 0.01;
          const name = token.name || token.symbol || tokenAddress;
          const price = token.priceUsd || token.price || '-';
          const dexUrl = token.url || (token.pairAddress ? `https://dexscreener.com/solana/${token.pairAddress}` : '');
          console.log(`[show_token] Attempting buy: User: ${userId}, Token: ${tokenAddress}, Amount: ${buyAmount}`);
          try {
            const buyResult = await unifiedBuy(tokenAddress, buyAmount, user.secret);
            console.log(`[show_token] Buy result:`, buyResult);
            const buyTx = extractTx(buyResult);
            if (buyTx) {
              successCount++;
              // Record the operation in history
              const entry = `AutoShowTokenBuy: ${tokenAddress} | Amount: ${buyAmount} SOL | Source: unifiedBuy | Tx: ${buyTx}`;
              user.history = user.history || [];
              user.history.push(entry);
              limitHistory(user);
              saveUsers(users);
              // Register an auto-sell order
              const targetPercent = user.strategy.targetPercent || 10;
              registerBuyWithTarget(user, { address: tokenAddress, price }, buyResult, targetPercent);
              buyResults.push(`🟢 <b>${name}</b> (<code>${tokenAddress}</code>)\nPrice: <b>${price}</b> USD\nAmount: <b>${buyAmount}</b> SOL\nTx: <a href='https://solscan.io/tx/${buyTx}'>${buyTx}</a>\n<a href='${dexUrl}'>DexScreener</a> | <a href='https://solscan.io/token/${tokenAddress}'>Solscan</a>\n------------------------------`);
            } else {
              failCount++;
              console.log(`[show_token] Buy failed for token: ${tokenAddress}`);
              buyResults.push(`🔴 <b>${name}</b> (<code>${tokenAddress}</code>)\n❌ Failed to buy.`);
            }
          } catch (e) {
            failCount++;
            console.log(`[show_token] Error during buy for token: ${tokenAddress}`, e);
            buyResults.push(`🔴 <b>${name}</b> (<code>${tokenAddress}</code>)\n❌ Error: ${getErrorMessage(e)}`);
          }
        }
        let summary = `<b>Auto Buy Summary</b>\n------------------------------\n✅ Success: <b>${successCount}</b>\n❌ Failed: <b>${failCount}</b>\n------------------------------`;
  await ctx.reply(summary + '\n' + buyResults.join('\n'), { parse_mode: 'HTML' });
// Handle Buy/Sell actions from show_token
bot.action(/showtoken_buy_(.+)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  // reload users from disk to pick up any runtime changes to strategy/wallet
  users = loadUsers();
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[showtoken_buy] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const amount = user.strategy.buyAmount || 0.01;
    // Validate mergedSignal (sollet+ledger) when available to avoid accidental buys
    try{
      const sniperMod = require('./sniper.js');
      const eng = sniperMod && sniperMod.ledgerEngine ? sniperMod.ledgerEngine : null;
      let mergedOk = false;
      // first, check in-memory notification queue where listener may have placed the token payload
      try{
        const q = ((global as any).__inMemoryNotifQueues && (global as any).__inMemoryNotifQueues.get(String(userId))) || [];
        if(Array.isArray(q) && q.length>0){
          for(const payload of q){
            try{
              const toks = payload && payload.tokens ? payload.tokens : (payload && payload.event && payload.event.candidateTokens) || payload && payload.candidateTokens;
              if(!toks) continue;
              const arr = Array.isArray(toks) ? toks : [toks];
              for(const tk of arr){ if((tk.tokenAddress||tk.address||tk.mint)===tokenAddress && tk.mergedSignal){ mergedOk = true; break; } }
              if(mergedOk) break;
            }catch(_){}
          }
        }
      }catch(_){}
      // fallback: query ledger engine directly
      if(!mergedOk && eng && typeof eng.getMaskForMint === 'function'){
        try{ const ls = eng.isStrongSignal(tokenAddress); if(ls) mergedOk = true; }catch(_e){}
      }
      // If not mergedOk, warn user and require explicit confirmation before buying
      if(!mergedOk){
        await ctx.reply(`⚠️ Token <code>${tokenAddress}</code> does not have a merged Sollet/Ledger signal (no strong evidence). Reply 'CONFIRM BUY ${tokenAddress}' to proceed.`, { parse_mode: 'HTML' });
        return;
      }
    }catch(_e){ /* ignore validation errors and proceed cautiously */ }

    await ctx.reply(`🛒 Buying token: <code>${tokenAddress}</code> with amount: <b>${amount}</b> SOL ...`, { parse_mode: 'HTML' });
    let result: any;
    try {
      result = await unifiedBuy(tokenAddress, amount, user.secret);
    } catch (err: any) {
      const msg = err && err.message ? String(err.message) : String(err);
      await ctx.reply('❌ Purchase cancelled: ' + msg);
      console.error('showtoken buy error:', err);
      return;
    }
    const showTx = extractTx(result);
    if (showTx) {
      const entry = `ShowTokenBuy: ${tokenAddress} | Amount: ${amount} SOL | Source: unifiedBuy | Tx: ${showTx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply(`Token bought successfully! Tx: ${showTx}`);
    } else {
      await ctx.reply('Buy failed: Transaction was not completed.');
    }
  } catch (e) {
    await ctx.reply('❌ Error during buy: ' + getErrorMessage(e));
    console.error('showtoken buy error:', e);
  }
});

bot.action(/showtoken_sell_(.+)/, async (ctx) => {
  const userId = String(ctx.from?.id);
  // reload users from disk to pick up any runtime changes to strategy/wallet
  users = loadUsers();
  const user = users[userId];
  const tokenAddress = ctx.match[1];
  console.log(`[showtoken_sell] User: ${userId}, Token: ${tokenAddress}`);
  if (!user || !hasWallet(user) || !user.strategy || !user.strategy.enabled) {
    await ctx.reply('❌ No active strategy or wallet found.');
    return;
  }
  try {
    const sellPercent = Number(user.strategy && (user.strategy.sellPercent1 ?? user.strategy.sellPercent ?? 100));
    const buyAmount = Number(user.strategy && user.strategy.buyAmount);
    if (!buyAmount || isNaN(buyAmount) || buyAmount <= 0) {
      await ctx.reply('❌ Cannot determine amount to sell because your strategy does not have a valid `buyAmount` configured. Set a buy amount in your strategy or use the sell command with an explicit amount.', { parse_mode: 'Markdown' });
      return;
    }
    // Use buyAmount as an estimated holding to compute sell amount when exact balance is unknown
    const balance = buyAmount;
    const amount = (balance * sellPercent) / 100;
    await ctx.reply(`🔻 Selling token: <code>${tokenAddress}</code> with <b>${sellPercent}%</b> of your balance (${balance}) ...`, { parse_mode: 'HTML' });
    const result = await unifiedSell(tokenAddress, amount, user.secret);
    if (result && result.tx) {
      const entry = `ShowTokenSell: ${tokenAddress} | Amount: ${amount} | Source: unifiedSell | Tx: ${result.tx}`;
      user.history = user.history || [];
      user.history.push(entry);
      limitHistory(user);
      saveUsers(users);
      await ctx.reply(`Token sold successfully! Tx: ${result.tx}`);
    } else {
      await ctx.reply('Sell failed: Transaction was not completed.');
    }
  } catch (e) {
    await ctx.reply('❌ Error during sell: ' + getErrorMessage(e));
    console.error('showtoken sell error:', e);
  }
});
      });

// =================== Bot Launch ===================
logt('--- About to launch bot ---');
(async () => {
  try {
    await bot.launch();
    logt('✅ Bot launched successfully (polling)');
  } catch (err: any) {
    if (err?.response?.error_code === 409) {
      console.error('❌ Bot launch failed: Conflict 409. Make sure the bot is not running elsewhere or stop all other sessions.');
      process.exit(1);
    } else {
      console.error('❌ Bot launch failed:', err);
      process.exit(1);
    }
  }
})();
logt('--- End of file reached ---');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});