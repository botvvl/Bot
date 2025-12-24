// Smart field-specific formatting for token stats
function fmtField(val: number | string | undefined | null, field: string): string {
  if (val === undefined || val === null || val === '-' || val === '' || val === 'N/A' || val === 'null' || val === 'undefined') return 'Not available';
  let num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);
  switch (field) {
    case 'price':
      if (Math.abs(num) >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
      if (Math.abs(num) >= 0.01) return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
      return num.toLocaleString(undefined, { maximumFractionDigits: 8 });
    case 'marketCap':
    case 'liquidity':
    case 'volume':
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    case 'holders':
    case 'age':
      return Math.round(num).toLocaleString();
    default:
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}
import axios from 'axios';


// ========== General Constants ==========
const EMPTY_VALUES = [undefined, null, '-', '', 'N/A', 'null', 'undefined'];

// Unified field map (easily extendable)
const FIELD_MAP: Record<string, string[]> = {
  marketCap: ['marketCap', 'fdv', 'totalAmount', 'amount'],
  liquidity: ['liquidity', 'liquidityUsd'],
  volume: ['volume', 'amount', 'totalAmount'],
  age: ['age', 'createdAt'],
};

const missingFieldsLog: Set<string> = new Set();



// Extract field value (supports nested paths)
export function getField(token: any, ...fields: string[]): any {
  for (let f of fields) {
    const mapped = FIELD_MAP[f] || [f];
    for (const mf of mapped) {
      // دعم المسارات المتداخلة
      const path = mf.split('.');
      let val = token;
      for (const key of path) {
        if (val == null) break;
        val = val[key];
      }
      if (!EMPTY_VALUES.includes(val)) return extractNumeric(val, val);
      if (mf in token && !EMPTY_VALUES.includes(token[mf])) return extractNumeric(token[mf], token[mf]);
    }
  }
  if (fields.length > 0) missingFieldsLog.add(fields[0]);
  return undefined;
}

// دالة لعرض الحقول المفقودة (للمطور أو المستخدم)
export function getMissingFields(): string[] {
  return Array.from(missingFieldsLog);
}

// Extract a number from any value (helper)
function extractNumeric(val: any, fallback?: number): number | undefined {
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string' && !isNaN(Number(val))) return Number(val);
  if (val && typeof val === 'object') {
    for (const k of ['usd','h24','amount','value','total','native','sol']) {
      if (typeof val[k] === 'number' && !isNaN(val[k])) return val[k];
    }
    for (const k in val) if (typeof val[k] === 'number' && !isNaN(val[k])) return val[k];
  }
  return fallback;
}


export async function retryAsync<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const retryAfter = err?.response?.headers?.['retry-after'];
      const wait = retryAfter ? Number(retryAfter) * 1000 : delayMs;
      if (i < retries - 1) await new Promise(res => setTimeout(res, wait));
    }
  }
  throw lastErr;
}


// ========== Fetch token data from CoinGecko and DexScreener ==========
export async function fetchSolanaFromCoinGecko(): Promise<any> {
  const url = 'https://api.coingecko.com/api/v3/coins/solana';
  try {
    return await retryAsync(async () => {
      const response = await axios.get(url);
      const data = response.data;
      return {
        name: data.name,
        symbol: data.symbol,
        priceUsd: data.market_data?.current_price?.usd,
        marketCap: data.market_data?.market_cap?.usd,
        volume: data.market_data?.total_volume?.usd,
        holders: data.community_data?.facebook_likes || '-',
        age: data.genesis_date,
        verified: true,
        description: data.description?.en,
        imageUrl: data.image?.large,
        links: [
          ...(data.links?.homepage?.[0] ? [{ label: 'Website', url: data.links.homepage[0], type: 'website' }] : []),
          ...(data.links?.twitter_screen_name ? [{ label: 'Twitter', url: `https://twitter.com/${data.links.twitter_screen_name}`, type: 'twitter' }] : []),
          ...(data.links?.subreddit ? [{ label: 'Reddit', url: `https://reddit.com${data.links.subreddit}`, type: 'reddit' }] : []),
        ],
        address: 'N/A',
        pairAddress: 'N/A',
        url: data.links?.blockchain_site?.[0] || '',
      };
    }, 3, 3000);
  } catch (err) {
    console.error('CoinGecko fetch error:', err);
    return null;
  }
}


// ========== User-editable fields (for strategies) ==========



/**
 * STRATEGY_FIELDS: Only user-editable filter fields (used for filtering tokens)
 * Users can only set these fields in their strategy.
 */
export type StrategyField = { key: string; label: string; type: string; optional: boolean; tokenField?: string };
// For this deployment we only collect trade settings (buy/sell amounts) via the strategy flow.
// Keep STRATEGY_FIELDS empty so the interactive flow jumps directly to trade settings.
export let STRATEGY_FIELDS: StrategyField[] = [];


// ========== DexScreener API Integration ==========

/**
 * Fetch token profiles from DexScreener API.
 * @param chainId Optional chainId to filter (e.g., 'solana').
 * @param extraParams Optional object for more query params.
 * @returns Array of token profiles.
 *
 * If the API does not support filtering, filtering will be done locally.
 */
export async function fetchDexScreenerProfiles(chainId?: string, extraParams?: Record<string, string>): Promise<any[]> {
  let url = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const params: Record<string, string> = {};
  if (chainId) params.chainId = chainId;
  if (extraParams) Object.assign(params, extraParams);
  const query = Object.keys(params).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  if (query) url += `?${query}`;
  try {
    const response = await axios.get(url);
    let data = Array.isArray(response.data) ? response.data : [];
    // If API does not support filtering, fallback to local filtering
    if (chainId && data.length && !data.some(t => t.chainId === chainId)) {
      data = data.filter((t: any) => t.chainId === chainId);
    }
    return data;
  } catch (err: any) {
    // Log more details
    const msg = err?.message || err?.toString() || 'Unknown error';
    const status = err?.response?.status;
    const urlInfo = url;
    console.error(`DexScreener token-profiles fetch error: ${msg} (status: ${status}) [${urlInfo}]`);
    // Optionally, throw or return a special error object
    throw new Error(`Failed to fetch token profiles from DexScreener: ${msg}`);
  }
}

export async function fetchDexScreenerPairsForSolanaTokens(tokenAddresses: string[]): Promise<any[]> {
  const chainId = 'solana';
  const allPairs: any[] = [];
  for (const tokenAddress of tokenAddresses) {
    const url = `https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`;
    try {
      const response = await axios.get(url);
      if (Array.isArray(response.data)) {
        allPairs.push(...response.data);
      }
    } catch (err) {
      // Ignore individual errors
    }
  }
  return allPairs;
}

/**
 * Fetch Solana tokens (or any chain) from DexScreener with optional params.
 * @param chainId Chain to fetch (default: 'solana')
 * @param extraParams Optional query params (e.g. { limit: '100' })
 */
export async function fetchDexScreenerTokens(chainId: string = 'solana', extraParams?: Record<string, string>): Promise<any[]> {
  // 1. Fetch tokens from token-profiles with filtering at API level
  const profiles = await fetchDexScreenerProfiles(chainId, extraParams ?? { limit: '100' });
  // 2. Fetch pairs (market data) for each token
  const tokenAddresses = profiles.map((t: any) => t.tokenAddress).filter(Boolean);
  const pairs = await fetchDexScreenerPairsForSolanaTokens(tokenAddresses);

  // 3. Merge data: for each token, merge profile with pairs (market data)
  const allTokens: Record<string, any> = {};
  for (const profile of profiles) {
    const addr = profile.tokenAddress;
    if (!addr) continue;
    allTokens[addr] = { ...profile };
  }
  // Add pairs (market data)
  for (const pair of pairs) {
    // Each pair has baseToken.address
    const addr = getField(pair, 'baseToken.address', 'tokenAddress', 'address', 'mint', 'pairAddress');
    if (!addr) continue;
    if (!allTokens[addr]) allTokens[addr] = {};
    // Merge pair data with token
    for (const key of Object.keys(FIELD_MAP)) {
      if (allTokens[addr][key] === undefined || EMPTY_VALUES.includes(allTokens[addr][key])) {
        const val = getField(pair, key);
        if (!EMPTY_VALUES.includes(val)) allTokens[addr][key] = val;
      }
    }
    // Get some fields from baseToken if missing
    if (pair.baseToken && typeof pair.baseToken === 'object') {
      for (const key of Object.keys(FIELD_MAP)) {
        if (allTokens[addr][key] === undefined || EMPTY_VALUES.includes(allTokens[addr][key])) {
          const val = getField(pair.baseToken, key);
          if (!EMPTY_VALUES.includes(val)) allTokens[addr][key] = val;
        }
      }
    }
    // liquidity: may be in pair.liquidity.usd or pair.liquidity
    if ((allTokens[addr].liquidity === undefined || EMPTY_VALUES.includes(allTokens[addr].liquidity)) && pair.liquidity) {
      if (typeof pair.liquidity === 'object' && typeof pair.liquidity.usd === 'number') allTokens[addr].liquidity = pair.liquidity.usd;
      else if (typeof pair.liquidity === 'number') allTokens[addr].liquidity = pair.liquidity;
    }
    // priceUsd
    if ((allTokens[addr].priceUsd === undefined || EMPTY_VALUES.includes(allTokens[addr].priceUsd)) && pair.priceUsd) {
      allTokens[addr].priceUsd = pair.priceUsd;
    }
    // marketCap
    if ((allTokens[addr].marketCap === undefined || EMPTY_VALUES.includes(allTokens[addr].marketCap)) && pair.fdv) {
      allTokens[addr].marketCap = pair.fdv;
    }
    if ((allTokens[addr].marketCap === undefined || EMPTY_VALUES.includes(allTokens[addr].marketCap)) && pair.marketCap) {
      allTokens[addr].marketCap = pair.marketCap;
    }

    // ====== استخراج الحقول الزمنية ======
    // الأولوية: pair.pairCreatedAt > pair.createdAt > pair.baseToken.createdAt > profile.createdAt > profile.genesis_date
    let createdTs =
      pair.pairCreatedAt ||
      pair.createdAt ||
      (pair.baseToken && pair.baseToken.createdAt) ||
      (allTokens[addr].createdAt) ||
      (allTokens[addr].genesis_date);

    // إذا كان نص تاريخ، حوّله إلى timestamp
    if (typeof createdTs === 'string' && !isNaN(Date.parse(createdTs))) {
      createdTs = Date.parse(createdTs);
    }
    // إذا كان بالثواني وليس ملي ثانية
    if (typeof createdTs === 'number' && createdTs < 1e12 && createdTs > 1e9) {
      createdTs = createdTs * 1000;
    }
    // إذا كان بالسنوات (مثلاً genesis_date)
    if (typeof createdTs === 'string' && /^\d{4}-\d{2}-\d{2}/.test(createdTs)) {
      createdTs = Date.parse(createdTs);
    }
    // حساب العمر بالدقائق
    let ageMinutes = undefined;
    if (typeof createdTs === 'number' && createdTs > 0) {
      ageMinutes = Math.floor((Date.now() - createdTs) / 60000);
    }
    allTokens[addr].pairCreatedAt = pair.pairCreatedAt || null;
    allTokens[addr].poolOpenTime = createdTs || null;
    allTokens[addr].ageMinutes = ageMinutes;
  }

  // 4. If not enough data, use CoinGecko fallback (same logic as before)
  let cgTokens: any[] = [];
  let coinGeckoFailed = false;
  if (Object.keys(allTokens).length === 0) {
    try {
      const solanaToken = await fetchSolanaFromCoinGecko();
      if (solanaToken) cgTokens.push(solanaToken);
      const listUrl = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
      const listResponse = await retryAsync(() => axios.get(listUrl), 3, 3000);
      const allTokensList = listResponse.data;
      const solanaTokens = allTokensList.filter((t: any) => t.platforms && t.platforms.solana);
      const limited = solanaTokens.slice(0, 10);
      const details = await Promise.all(limited.map(async (t: any) => {
        try {
          const url = `https://api.coingecko.com/api/v3/coins/${t.id}`;
          const response = await retryAsync(() => axios.get(url), 3, 3000);
          const data = response.data;
          return {
            name: data.name,
            symbol: data.symbol,
            priceUsd: data.market_data?.current_price?.usd,
            marketCap: data.market_data?.market_cap?.usd,
            volume: data.market_data?.total_volume?.usd,
            holders: data.community_data?.facebook_likes || '-',
            age: data.genesis_date,
            verified: true,
            description: data.description?.en,
            imageUrl: data.image?.large,
            links: [
              ...(data.links?.homepage?.[0] ? [{ label: 'Website', url: data.links.homepage[0], type: 'website' }] : []),
              ...(data.links?.twitter_screen_name ? [{ label: 'Twitter', url: `https://twitter.com/${data.links.twitter_screen_name}`, type: 'twitter' }] : []),
              ...(data.links?.subreddit ? [{ label: 'Reddit', url: `https://reddit.com${data.links.subreddit}`, type: 'reddit' }] : []),
            ],
            address: t.platforms.solana,
            pairAddress: t.platforms.solana,
            url: data.links?.blockchain_site?.[0] || '',
            // الحقول الزمنية من CoinGecko
            poolOpenTime: data.genesis_date ? Date.parse(data.genesis_date) : null,
            ageMinutes: data.genesis_date ? Math.floor((Date.now() - Date.parse(data.genesis_date)) / 60000) : null,
          };
        } catch (err) {
          return null;
        }
      }));
      cgTokens = cgTokens.concat(details.filter(Boolean));
    } catch (err) {
      coinGeckoFailed = true;
      console.error('CoinGecko Solana tokens fetch error:', err);
    }
    if (coinGeckoFailed || cgTokens.length === 0) {
      console.warn('CoinGecko unavailable, no tokens fetched.');
      cgTokens = [];
    }
    // Add them to allTokens
    for (const t of cgTokens) {
      const addr = t.address || t.tokenAddress || t.mint || t.pairAddress;
      if (!addr) continue;
      allTokens[addr] = { ...t };
    }
  }
  return Object.values(allTokens);
}

// ========== Formatting and display functions ==========
export function fmt(val: number | string | undefined | null, digits?: number, unit?: string): string {
  if (val === undefined || val === null) return '-';
  let num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);
  let usedDigits = digits !== undefined ? digits : (Math.abs(num) < 1 ? 6 : 2);
  let str = num.toLocaleString(undefined, { maximumFractionDigits: usedDigits });
  if (unit) str += ' ' + unit;
  return str;
}



// --- Helper functions for building the message ---

function buildInlineKeyboard(token: any, botUsername: string, pairAddress: string, userId?: string) {
  const dexUrl = token.url || (pairAddress ? `https://dexscreener.com/solana/${pairAddress}` : '');
  const twitterEmoji = '🐦', dexEmoji = '🧪', shareEmoji = '📤';
  const inlineKeyboard: any[][] = [];
  // Row 1: Twitter, DexScreener (only if available)
  const row1: any[] = [];
  if (Array.isArray(token.links)) {
    for (const l of token.links) {
      if (l.type === 'twitter' && l.url) row1.push({ text: `${twitterEmoji} Twitter`, url: l.url });
    }
  }
  if (dexUrl) row1.push({ text: `${dexEmoji} DexScreener`, url: dexUrl });
  if (row1.length) inlineKeyboard.push(row1);
  // Row 2: Share button (external share link)
  let shareId = userId || token._userId || (token.tokenAddress || token.address || token.mint || token.pairAddress || '');
  // External share link (Telegram deep link with share parameter)
  const shareUrl = `https://t.me/share/url?url=https://t.me/${botUsername}?start=${shareId}`;
  const row2: any[] = [ { text: `${shareEmoji} Share`, url: shareUrl } ];
  inlineKeyboard.push(row2);
  // Row 3: Buy / Sell buttons (callback) to match show-token handlers
  try {
    const addr = token.tokenAddress || token.address || token.mint || token.pairAddress || '';
    if (addr) {
      const buyText = '🟢 Buy';
      const sellText = '🔴 Sell';
      // Use showtoken_* callbacks to align with existing show_token handlers
      const buyCb = `showtoken_buy_${addr}`;
      const sellCb = `showtoken_sell_${addr}`;
      inlineKeyboard.push([ { text: buyText, callback_data: buyCb }, { text: sellText, callback_data: sellCb } ]);
    }
  } catch (e) { /* ignore */ }
  return { inlineKeyboard };
}

// --- Helper functions for building the message ---
function getTokenCoreFields(token: any) {
  return {
    name: token.name || token.baseToken?.name || '',
    symbol: token.symbol || token.baseToken?.symbol || '',
    address: token.tokenAddress || token.address || token.mint || token.pairAddress || token.url?.split('/').pop() || '',
    dexUrl: token.url || (token.pairAddress ? `https://dexscreener.com/solana/${token.pairAddress}` : ''),
    logo: token.imageUrl || token.logoURI || token.logo || token.baseToken?.logoURI || ''
  };
}

function getTokenStats(token: any) {
  const price = extractNumeric(getField(token, 'priceUsd', 'price', 'baseToken.priceUsd', 'baseToken.price'), 0);
  const marketCap = extractNumeric(getField(token, 'marketCap'));
  const liquidity = extractNumeric(getField(token, 'liquidity'));
  const volume = extractNumeric(getField(token, 'volume'));
  const holders = extractNumeric(getField(token, 'holders'));
  let age = getField(token, 'age', 'createdAt');
  // حذف سطر الهولدرز نهائياً
  let ageDisplay: string = 'Not available';
  let ageMs: number | undefined = undefined;
  if (typeof age === 'string') age = Number(age);
  if (typeof age === 'number' && !isNaN(age)) {
    if (age > 1e12) ageMs = Date.now() - age; // ms timestamp
    else if (age > 1e9) ageMs = Date.now() - age * 1000; // s timestamp
    else if (age < 1e7 && age > 0) ageMs = age * 60 * 1000; // minutes
  }
  if (typeof ageMs === 'number' && !isNaN(ageMs) && ageMs > 0) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ageMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((ageMs % (60 * 1000)) / 1000);
    if (days > 0) {
      ageDisplay = `${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) ageDisplay += ` ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      ageDisplay = `${hours} hour${hours > 1 ? 's' : ''}`;
      if (minutes > 0) ageDisplay += ` ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      ageDisplay = `${minutes} minute${minutes > 1 ? 's' : ''}`;
      if (seconds > 0) ageDisplay += ` ${seconds} second${seconds > 1 ? 's' : ''}`;
    } else {
      ageDisplay = `${seconds} second${seconds > 1 ? 's' : ''}`;
    }
  }
  return { price, marketCap, liquidity, volume, holders, ageDisplay };
}

function getTokenBuySell(token: any) {
  const buyVol = extractNumeric(token.buyVolume || token.buy_volume || token.volumeBuy || token.volume_buy);
  const sellVol = extractNumeric(token.sellVolume || token.sell_volume || token.volumeSell || token.volume_sell);
  return { buyVol, sellVol };
}

function buildExtraFields(token: any) {
  // Add unimportant fields to the skip list
  const skipFields = new Set([
    'name','baseToken','tokenAddress','address','mint','pairAddress','url','imageUrl','logoURI','logo','links','description','symbol','priceUsd','price','marketCap','liquidity','volume','holders','age','genesis_date','pairCreatedAt',
    'icon','header','openGraph' // unimportant fields
  ]);
  let msg = '';
  for (const key of Object.keys(token)) {
    if (skipFields.has(key)) continue;
    let value = token[key];
    if (value === undefined || value === null || value === '' || value === '-' || value === 'N/A' || value === 'null' || value === 'undefined') continue;
    if (typeof value === 'number') {
      msg += `<b>${key}:</b> ${fmt(value, 6)}\n`;
    } else if (typeof value === 'string') {
      // Don't show any image links or pictures
      if (/^https?:\/\/.*\.(png|jpg|jpeg|gif|webp)$/i.test(value)) {
        continue;
      } else if (/^https?:\/.*/.test(value)) {
        // If it's a link, show it as a link with an emoji only
        msg += `<b>${key}:</b> <a href='${value}'>🔗</a>\n`;
      } else {
        msg += `<b>${key}:</b> ${value}\n`;
      }
    } else if (typeof value === 'boolean') {
      msg += `<b>${key}:</b> ${value ? '✅' : '❌'}\n`;
    } else if (typeof value === 'object') {
      const numVal = extractNumeric(value);
      if (numVal !== undefined) {
        msg += `<b>${key}:</b> ${fmt(numVal, 6)}\n`;
      } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
        msg += `<b>${key}:</b> ${value.join(', ')}\n`;
      }
    }
  }
  return msg;
}

export function buildTokenMessage(token: any, botUsername: string, pairAddress: string, userId?: string): { msg: string, inlineKeyboard: any[][] } {
  const { name, symbol, address, dexUrl, logo } = getTokenCoreFields(token);
  const { price, marketCap, liquidity, volume, holders, ageDisplay } = getTokenStats(token);
  const { buyVol, sellVol } = getTokenBuySell(token);
  // --- Emojis ---
  const solEmoji = '🟣', memecoinEmoji = '🚀', chartEmoji = '📈', capEmoji = '💰', liqEmoji = '💧', volEmoji = '🔊', holdersEmoji = '👥', ageEmoji = '⏱️', linkEmoji = '🔗';
  // --- Message header ---
  let msg = '';
  // Show token name and symbol clearly
  msg += `🪙${solEmoji} <b>${name ? name : 'Not available'}</b>${symbol ? ' <code>' + symbol + '</code>' : ''}\n`;
  msg += `${linkEmoji} <b>Address:</b> <code>${address ? address : 'Not available'}</code>\n`;
  // --- Stats ---
  msg += `${capEmoji} <b>Market Cap:</b> ${fmtField(marketCap, 'marketCap')} USD\n`;
  msg += `${liqEmoji} <b>Liquidity:</b> ${fmtField(liquidity, 'liquidity')} USD  `;
  if (typeof liquidity === 'number' && !isNaN(liquidity) && typeof marketCap === 'number' && marketCap > 0) {
    const liqPct = Math.min(100, Math.round((liquidity / marketCap) * 100));
    msg += progressBar(liqPct, 10, '🟦', '⬜') + ` ${liqPct}%\n`;
  } else {
    msg += '\n';
  }
  msg += `${volEmoji} <b>Volume 24h:</b> ${fmtField(volume, 'volume')} USD  `;
  if (typeof volume === 'number' && !isNaN(volume) && typeof marketCap === 'number' && marketCap > 0) {
    const volPct = Math.min(100, Math.round((volume / marketCap) * 100));
    msg += progressBar(volPct, 10, '🟩', '⬜') + ` ${volPct}%\n`;
  } else {
    msg += '\n';
  }
  msg += `${ageEmoji} <b>Age:</b> ${ageDisplay}\n`;
  msg += `${chartEmoji} <b>Price:</b> ${fmtField(price, 'price')} USD\n`;
  // --- Buy/Sell progress bar ---
  if (buyVol !== undefined || sellVol !== undefined) {
    const totalVol = (buyVol || 0) + (sellVol || 0);
    if (totalVol > 0) {
      const buyPct = Math.round((buyVol || 0) / totalVol * 100);
      const sellPct = 100 - buyPct;
      msg += `🟢 Buy:  ${progressBar(buyPct, 10, '🟩', '⬜')} ${buyPct}%\n`;
      msg += `🔴 Sell: ${progressBar(sellPct, 10, '🟥', '⬜')} ${sellPct}%\n`;
    }
  }
  // --- Extra fields ---
  msg += buildExtraFields(token);
  // --- Description ---
  if (token.description) msg += `\n<em>${token.description}</em>\n`;
  // --- Network line ---
  if (token.chainId || token.chain || token.chainName) {
    const network = token.chainId || token.chain || token.chainName;
    msg += `🌐 <b>Network:</b> ${network}\n`;
  }
  // --- Only add community/footer line ---
  msg += `\n${memecoinEmoji} <b>Solana Memecoin Community</b> | ${solEmoji} <b>Powered by DexScreener</b>\n`;
  // --- Inline keyboard (all links/buttons at the bottom) ---
  const { inlineKeyboard } = buildInlineKeyboard(token, botUsername, pairAddress, userId);
  return { msg, inlineKeyboard };
}

function progressBar(percent: number, size = 10, fill = '█', empty = '░') {
  const filled = Math.round((percent / 100) * size);
  return fill.repeat(filled) + empty.repeat(size - filled);
}


// Notify users with matching tokens (always uses autoFilterTokens)
export async function notifyUsers(bot: any, users: Record<string, any>, tokens: any[]) {
  for (const uid of Object.keys(users)) {
    const strategy: Record<string, any> = users[uid]?.strategy || {};
    const filtered = autoFilterTokens(tokens, strategy);
    if (filtered.length > 0 && bot) {
      for (const token of filtered) {
        const chain = (token.chainId || token.chain || token.chainName || '').toString().toLowerCase();
        if (chain && !chain.includes('sol')) continue;
        let botUsername = (bot && bot.botInfo && bot.botInfo.username) ? bot.botInfo.username : (process.env.BOT_USERNAME || 'YourBotUsername');
        const address = token.tokenAddress || token.address || token.mint || token.pairAddress || 'N/A';
        const pairAddress = token.pairAddress || address;
        const { msg, inlineKeyboard } = buildTokenMessage(token, botUsername, pairAddress);
        // Extra protection: if msg is not a string, skip sending
        if (typeof msg !== 'string') {
          await bot.telegram.sendMessage(uid, '⚠️ We are still looking for the gems you want.');
          continue;
        }
        await bot.telegram.sendMessage(uid, msg, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
      }
    } else if (bot) {
      await bot.telegram.sendMessage(
        uid,
        'No tokens currently match your strategy.\n\nYour strategy filters may be too strict for the available data from DexScreener.\n\nTry lowering requirements like liquidity, market cap, volume, age, or holders, then try again.',
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        }
      );
    }
  }
}


// Unified token filtering by strategy
export function autoFilterTokens(tokens: any[], strategy: Record<string, any>): any[] {
  return tokens.filter(token => {
    for (const field of STRATEGY_FIELDS) {
      if (!field.tokenField || !(field.key in strategy)) continue;
      const value = strategy[field.key];
      if (field.type === "number" && (value === undefined || value === null || Number(value) === 0)) continue;
      let tokenValue = getField(token, field.tokenField);
      // Special cases support
      if (field.tokenField === 'liquidity' && tokenValue && typeof tokenValue === 'object' && typeof tokenValue.usd === 'number') {
        tokenValue = tokenValue.usd;
      }
      if (field.tokenField === 'volume' && tokenValue && typeof tokenValue === 'object' && typeof tokenValue.h24 === 'number') {
        tokenValue = tokenValue.h24;
      }
      if (field.tokenField === 'age') {
        let ageVal = tokenValue;
        if (typeof ageVal === 'string') ageVal = Number(ageVal);
        if (ageVal > 1e12) {
          tokenValue = Math.floor((Date.now() - ageVal) / 60000);
        } else if (ageVal > 1e9) {
          tokenValue = Math.floor((Date.now() - ageVal * 1000) / 60000);
        }
      }
      // تطبيع القيمة الرقمية دائماً
      tokenValue = extractNumeric(tokenValue);
      const numValue = Number(value);
      const numTokenValue = Number(tokenValue);
      if (isNaN(numTokenValue)) {
        if (!field.optional) {
          return false;
        } else {
          continue;
        }
      }
      if (field.type === "number") {
        if (field.key.startsWith("min") && !isNaN(numValue)) {
          if (numTokenValue < numValue) {
            return false;
          }
        }
        if (field.key.startsWith("max") && !isNaN(numValue)) {
          if (numTokenValue > numValue) {
            return false;
          }
        }
      }
      if (field.type === "boolean" && typeof value === "boolean") {
        if (value === true && !tokenValue) {
          return false;
        }
        if (value === false && tokenValue) {
          return false;
        }
      }
    }
    return true;
  });
}

// ========== Signing Key Utilities ==========
const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js");

export function loadKeypair(secretKey: string) {
  try {
    // إذا كانت Base58
    if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(secretKey)) {
      return Keypair.fromSecretKey(bs58.decode(secretKey));
    }
    // إذا كانت Base64
    if (/^[A-Za-z0-9+/]+=*$/.test(secretKey)) {
      return Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));
    }
    throw new Error("صيغة المفتاح غير معروفة");
  } catch (err: any) {
    throw new Error("فشل تحميل المفتاح: " + err.message);
  }
}

// ========== Timeout Utility ==========
export function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${source}`)), ms)
    )
  ]);
}

// ========== Logging Utility ==========
export function logTrade(trade: {
  action: string;
  source: string;
  token: string;
  amount: number;
  price: number | null;
  tx: string | null;
  latency: number;
  status: string;
}) {
  console.log(`[TRADE] ${trade.action} | ${trade.source} | Token: ${trade.token} | Amount: ${trade.amount} | Price: ${trade.price} | Tx: ${trade.tx} | Latency: ${trade.latency}ms | Status: ${trade.status}`);
}