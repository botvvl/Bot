import { Connection } from "@solana/web3.js";
import rpcPool from './utils/rpcPool';

// Centralized config used by src/ files. Values fall back to reasonable defaults
// and can be overridden via environment variables.

export const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
export const PRIVATE_RPC_ENDPOINT = process.env.PRIVATE_RPC_ENDPOINT || RPC_URL;
export const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || undefined;
export const COMMITMENT_LEVEL = (process.env.COMMITMENT_LEVEL as any) || "confirmed";

export const RAYDIUM_AMM_URL = process.env.RAYDIUM_AMM_URL || "https://api.raydium.io/v2/main/amm";
export const RAYDIUM_CLMM_URL = process.env.RAYDIUM_CLMM_URL || "https://api.raydium.io/v2/main/clmm";

export const RAYDIUM_PASS_TIME = Number(process.env.RAYDIUM_PASS_TIME || 1000 * 60 * 120); // default 120 minutes in ms
export const RESERVE_WALLET = process.env.RESERVE_WALLET || process.env.RESERVE_ADDRESS || "11111111111111111111111111111111";

export const BIRDEYE_API_URL = process.env.BIRDEYE_API_URL || "https://public-api.birdeye.so";
export const REQUEST_HEADER: Record<string, string> = (() => {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (process.env.BIRDEYE_API_KEY) headers["x-api-key"] = process.env.BIRDEYE_API_KEY;
	return headers;
})();

export const GrowTradeVersion = process.env.GROWTRADE_VERSION || "v1";
export const MAX_WALLET = Number(process.env.MAX_WALLET || 5);
export const PNL_SHOW_THRESHOLD_USD = Number(process.env.PNL_SHOW_THRESHOLD_USD || 0);

// Pump-related constants (fallback to sensible defaults or env values)
export const GLOBAL_WALLET = process.env.GLOBAL_WALLET || process.env.PUMP_FUN_ACCOUNT || "11111111111111111111111111111111";
export const FEE_RECIPIENT = process.env.FEE_RECIPIENT || "11111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = process.env.SYSTEM_PROGRAM_ID || "11111111111111111111111111111111";
export const RENT = process.env.RENT || "SysvarRent111111111111111111111111111111111";
export const PUMP_FUN_ACCOUNT = process.env.PUMP_FUN_ACCOUNT || "11111111111111111111111111111111111111111";
export const PUMP_FUN_PROGRAM = process.env.PUMP_FUN_PROGRAM || process.env.PUMP_FUN_PROGRAM || "11111111111111111111111111111111111111111";
export const ASSOC_TOKEN_ACC_PROG = process.env.ASSOC_TOKEN_ACC_PROG || "11111111111111111111111111111111";

// Runtime enums used across UI code. Previously only types existed which caused
// callers to attempt to use these as runtime values. Provide small numeric
// constants here so callers can use them directly.
export const GasFeeEnum = {
	LOW: 0,
	MEDIUM: 1,
	HIGH: 2,
} as const;

export const JitoFeeEnum = {
	DISABLED: 0,
	ENABLED: 1,
} as const;

// Export pre-built Connection instances for convenience. Some modules expect both
// a public connection and a private_connection for privileged calls.
// Use rpcPool to obtain connections so the app benefits from rotation/backoff
export const connection = rpcPool.getRpcConnection(RPC_URL);
export const private_connection = rpcPool.getRpcConnection(PRIVATE_RPC_ENDPOINT || RPC_URL);

export const getRpcPool = () => rpcPool;

// Probe and watcher tuning defaults
export const PROBE_TTL_MS = Number(process.env.PROBE_TTL_MS || 10000);
export const PROBE_RETRY = Number(process.env.PROBE_RETRY || 1);
export const PROBE_BACKOFF_BASE_MS = Number(process.env.PROBE_BACKOFF_BASE_MS || 10);

export const READY_SCORE_THRESHOLD = Number(process.env.READY_SCORE_THRESHOLD || 0.80);
export const FINAL_REPROBE_PER_PROBE_MS = Number(process.env.FINAL_REPROBE_PER_PROBE_MS || 12);
export const FINAL_REPROBE_JUPITER_MS = Number(process.env.FINAL_REPROBE_JUPITER_MS || 18);
export const FIND_TIMEOUT_MS = Number(process.env.FIND_TIMEOUT_MS || 120000);

// Notification defaults
export const NOTIFY_ADMIN_ID = process.env.NOTIFY_ADMIN_ID || (process.env.ADMIN_IDS ? (process.env.ADMIN_IDS.split(',')[0] || null) : null);

// Keep default export minimal (not required) but helpful for CommonJS consumers
export default {
	RPC_URL,
	PRIVATE_RPC_ENDPOINT,
	RPC_WEBSOCKET_ENDPOINT,
	COMMITMENT_LEVEL,
	RAYDIUM_AMM_URL,
	RAYDIUM_CLMM_URL,
	BIRDEYE_API_URL,
	REQUEST_HEADER,
	GrowTradeVersion,
	MAX_WALLET,
	PNL_SHOW_THRESHOLD_USD,
	connection,
	private_connection,
	getRpcPool,
};
