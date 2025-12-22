import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  TransactionExpiredBlockheightExceededError,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import promiseRetry from "promise-retry";
import { wait } from "./wait";
import * as rpcPool from './rpcPool';

function getRpcUrlCandidates(): string[] {
  const env = process.env;
  const urls = [
    // prefer explicit Helius endpoints first if present
    env.HELIUS_RPC_URL,
    env.HELIUS_FAST_RPC_URL_2,
    env.HELIUS_RPC_URL_2,
    // then configured RPC_URL / SOLANA_RPC_URL
    env.RPC_URL,
    env.SOLANA_RPC_URL,
    env.SOLANA_API_URL,
    env.MAINNET_RPC,
  ].filter(Boolean) as string[];
  // always include a default at the end
  urls.push('https://api.mainnet-beta.solana.com');
  // dedupe while preserving order
  return urls.filter((v, i) => urls.indexOf(v) === i);
}

type TransactionSenderAndConfirmationWaiterArgs = {
  connection: Connection;
  serializedTransaction: Buffer;
  blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight;
  // optional send options to control preflight behavior
  sendOptions?: { skipPreflight?: boolean, highPriority?: boolean };
};

// default send options (preserve previous behavior)
const DEFAULT_SEND_OPTIONS = {
  skipPreflight: true,
};

export async function transactionSenderAndConfirmationWaiter({
  connection,
  serializedTransaction,
  blockhashWithExpiryBlockHeight,
  sendOptions,
}: TransactionSenderAndConfirmationWaiterArgs): Promise<VersionedTransactionResponse | null> {
  // Default to DRY-RUN unless explicitly enabled. Require CONFIRM_SEND==='yes' as extra guard.
  const liveTrades = String(process.env.LIVE_TRADES || '').toLowerCase() === 'true';
  const confirmSend = String(process.env.CONFIRM_SEND || '').toLowerCase() === 'yes';
  console.log('[transactionSenderAndConfirmationWaiter] liveTrades=', liveTrades, 'confirmSend=', confirmSend);
  if (!liveTrades || !confirmSend) {
    console.warn('[transactionSenderAndConfirmationWaiter] DRY-RUN: live sends are disabled. Set LIVE_TRADES=true and CONFIRM_SEND=yes to enable live sends.');
    // Return null to indicate DRY-RUN (caller should treat as simulated)
    return null;
  }
  const options = sendOptions || DEFAULT_SEND_OPTIONS;
  const highPriority = (options && (options as any).highPriority) || String(process.env.HIGH_PRIORITY || '').toLowerCase() === 'true';
  let txid: string | undefined;
  try {
    // If highPriority requested, attempt preferred fast RPC first (env or pool)
    if (highPriority) {
      const prefer = process.env.HIGH_PRIORITY_RPC_URL || process.env.HELIUS_FAST_RPC_URL_2 || (rpcPool.getHealthyCandidates && rpcPool.getHealthyCandidates()[0]);
      if (prefer) {
        try {
          const fastConn = rpcPool.getRpcConnection(prefer);
          txid = await fastConn.sendRawTransaction(serializedTransaction, options);
          connection = fastConn; // switch to fast connection for confirmation
        } catch (fastErr) {
          // fall back to primary connection below
          console.warn('[transactionSenderAndConfirmationWaiter] highPriority fast send failed:', (fastErr as any)?.message ?? fastErr);
        }
      }
    }
    if (!txid) {
      txid = await connection.sendRawTransaction(
        serializedTransaction,
        options
      );
    }
  } catch (firstErr: any) {
    // Print diagnostics for first error
    try {
      if (firstErr && typeof firstErr === 'object') {
        // Safely attempt to call getLogs() if available. getLogs() may itself throw or return
        // a rejected promise when the internal connection is unavailable; handle that.
        if ('getLogs' in firstErr && typeof firstErr.getLogs === 'function') {
          try {
            const logs = await Promise.resolve(firstErr.getLogs());
            console.error('[transactionSenderAndConfirmationWaiter] SendTransactionError getLogs():', logs);
          } catch (glErr) {
            // getLogs failed; attempt to surface transactionLogs if present (it may be a Promise)
            console.error('[transactionSenderAndConfirmationWaiter] getLogs() threw:', (glErr as any)?.message ?? String(glErr));
            // If the error contains a signature and we have a connection, try to fetch the transaction directly
            try {
              const sig = (firstErr && (firstErr.signature || firstErr.txSignature || firstErr.transactionSignature)) ? (firstErr.signature || firstErr.txSignature || firstErr.transactionSignature) : null;
              if (sig && connection && typeof connection.getTransaction === 'function') {
                try {
                  const tx = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 } as any);
                  console.error('[transactionSenderAndConfirmationWaiter] getTransaction fallback logs:', tx && (tx.meta && tx.meta.logMessages ? tx.meta.logMessages : tx));
                } catch (getTxErr) {
                  console.error('[transactionSenderAndConfirmationWaiter] getTransaction fallback failed:', (getTxErr as any)?.message ?? String(getTxErr));
                }
              }
            } catch (_) {}
            if ('transactionLogs' in firstErr && firstErr.transactionLogs) {
              try {
                const resolved = await Promise.resolve(firstErr.transactionLogs);
                console.error('[transactionSenderAndConfirmationWaiter] error.transactionLogs (resolved):', resolved);
              } catch (tErr) {
                console.error('[transactionSenderAndConfirmationWaiter] error.transactionLogs (rejected):', (tErr as any)?.message ?? String(tErr));
              }
            }
          }
        } else if ('transactionLogs' in firstErr && firstErr.transactionLogs) {
          try {
            const resolved = await Promise.resolve(firstErr.transactionLogs);
            console.error('[transactionSenderAndConfirmationWaiter] error.transactionLogs:', resolved);
          } catch (tErr) {
            console.error('[transactionSenderAndConfirmationWaiter] error.transactionLogs (rejected):', (tErr as any)?.message ?? String(tErr));
          }
        }
        if ('message' in firstErr) console.error('[transactionSenderAndConfirmationWaiter] sendRawTransaction error message:', firstErr.message);
        // Print stack if available for better diagnostics
        try {
          if (firstErr && firstErr.stack) console.error('[transactionSenderAndConfirmationWaiter] firstErr.stack:', firstErr.stack);
        } catch (_) {}
        try {
          console.error('[transactionSenderAndConfirmationWaiter] first sendRawTransaction error object:', JSON.stringify(firstErr, Object.getOwnPropertyNames(firstErr), 2));
        } catch (jsErr) {
          console.error('[transactionSenderAndConfirmationWaiter] first sendRawTransaction error (non-serializable):', firstErr);
        }
      }
    } catch (diagErr) {
      console.error('[transactionSenderAndConfirmationWaiter] error while printing diagnostics for firstErr:', diagErr);
    }

      // Try fallback RPCs from rpcPool (prefer healthy candidates)
  const candidates = (rpcPool as any).getHealthyCandidates ? (rpcPool as any).getHealthyCandidates() : rpcPool.getRpcCandidates();
      console.warn('[transactionSenderAndConfirmationWaiter] Attempting fallback RPCs from rpcPool, candidates:', candidates);
      try {
        // print any last failure reasons recorded in rpcPool for diagnostics
        const reasons: Record<string,string|null> = {};
        if ((rpcPool as any).getLastFailureReason) {
          for (const c of candidates) {
            try { reasons[c] = (rpcPool as any).getLastFailureReason(c) || null; } catch (_) { reasons[c] = null; }
          }
          console.warn('[transactionSenderAndConfirmationWaiter] rpcPool lastFailureReason map:', reasons);
        }
      } catch (_) {}
      for (let i = 0; i < candidates.length; i++) {
        const url = candidates[i];
        try {
          if (!url) continue;
          console.log(`[transactionSenderAndConfirmationWaiter] trying RPC from pool: ${url}`);
          const altConn = rpcPool.getRpcConnection(url);
          try {
            txid = await altConn.sendRawTransaction(serializedTransaction, options);
          } catch (sendErr) {
            // mark failure and rethrow to outer catch for logging
            const reason = (sendErr && (sendErr as any).message) ? (sendErr as any).message : String(sendErr);
            if ((rpcPool as any).markFailureWithReason) (rpcPool as any).markFailureWithReason(url, reason);
            else rpcPool.markFailure(url);
            // If rate-limited, wait a bit before next candidate to reduce thrashing
            try {
              if (String(reason).toLowerCase().includes('429') || String(reason).toLowerCase().includes('too many')) {
                await wait(500);
              }
            } catch (_) {}
            throw sendErr;
          }
          // success: mark success, swap connection reference and break
          rpcPool.markSuccess(url);
          connection = altConn;
          console.log('[transactionSenderAndConfirmationWaiter] sendRawTransaction succeeded via pool RPC:', url, 'txid=', txid);
          break;
        } catch (e: any) {
          console.warn(`[transactionSenderAndConfirmationWaiter] sendRawTransaction failed on ${url}:`, (e && e.message) || e);
          // attempt to log logs/transactionLogs if present (best-effort)
          try {
            if (e && typeof e === 'object') {
              if ('getLogs' in e && typeof e.getLogs === 'function') {
                try {
                  const logs = await Promise.resolve(e.getLogs());
                  console.error('[transactionSenderAndConfirmationWaiter] fallback getLogs():', logs);
                } catch (glErr) {
                  console.error('[transactionSenderAndConfirmationWaiter] fallback getLogs() threw:', (glErr as any)?.message ?? String(glErr));
                }
              } else if ('transactionLogs' in e && e.transactionLogs) {
                try {
                  const resolved = await Promise.resolve(e.transactionLogs);
                  console.error('[transactionSenderAndConfirmationWaiter] fallback error.transactionLogs:', resolved);
                } catch (tErr) {
                  console.error('[transactionSenderAndConfirmationWaiter] fallback error.transactionLogs (rejected):', (tErr as any)?.message ?? String(tErr));
                }
              }
            }
          } catch (_) {}
          // small delay before next candidate to avoid tight loop against overloaded RPCs
          try { await wait(200); } catch (_) {}
        }
      }

      if (!txid) {
        // no fallback succeeded, rethrow original
        throw firstErr;
      }
  }

  const controller = new AbortController();
  const abortSignal = controller.signal;
  // Aggressive resender for high-priority sends (fires immediately and then frequently).
  const abortableResender = async () => {
    const aggressive = highPriority;
    let attempt = 0;
    while (true) {
      try {
        if (abortSignal.aborted) return;
        // On first iteration, send immediately (no wait) to improve chances of being second in-order.
        if (attempt === 0) {
          await connection.sendRawTransaction(serializedTransaction, options).catch(()=>null);
        } else {
          await wait(aggressive ? 150 : 2000);
          if (abortSignal.aborted) return;
          await connection.sendRawTransaction(serializedTransaction, options).catch(()=>null);
        }
      } catch (e) {
        console.warn(`Failed to resend transaction: ${e}`);
      }
      attempt++;
    }
  };

  try {
    abortableResender();
    // Use the provided blockhashWithExpiryBlockHeight as-is. Subtracting a large
    // number here artificially shortens the available confirmation window and
    // can cause TransactionExpiredBlockheightExceededError even when the
    // transaction was recently broadcast. Use the value directly so callers can
    // rely on the blockhash expiry returned by the source (e.g. Jupiter).
    const lastValidBlockHeight = blockhashWithExpiryBlockHeight.lastValidBlockHeight;

    // this would throw TransactionExpiredBlockheightExceededError
    await Promise.race([
      connection.confirmTransaction(
        {
          ...blockhashWithExpiryBlockHeight,
          lastValidBlockHeight,
          signature: txid,
          abortSignal,
        },
        "confirmed"
      ),
      new Promise(async (resolve) => {
        // in case ws socket died
        while (!abortSignal.aborted) {
          await wait(highPriority ? 200 : 2_000);
          const tx = await connection.getSignatureStatus(txid, {
            searchTransactionHistory: false,
          });
          if (tx?.value?.confirmationStatus === "confirmed") {
            resolve(tx);
          }
        }
      }),
    ]);
  } catch (e) {
    if (e instanceof TransactionExpiredBlockheightExceededError) {
      // we consume this error and getTransaction would return null
      console.warn('[transactionSenderAndConfirmationWaiter] TransactionExpiredBlockheightExceededError: blockhash expired before confirmation; returning null');
      return null;
    } else {
      // invalid state from web3.js
      throw e;
    }
  } finally {
    controller.abort();
  }

  // in case rpc is not synced yet, we add some retries
  const response = promiseRetry(
    async (retry: any) => {
      const response = await connection.getTransaction(txid, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!response) {
        retry(response);
      }
      return response;
    },
    {
      retries: 5,
      minTimeout: 1e3,
    }
  );

  return response;
}

// Manual verbose sender: broadcast raw tx and poll signature status with detailed logs
export async function manualSendRawTransactionVerbose({ connection, serializedTransaction, sendOptions }: { connection: Connection; serializedTransaction: Buffer; sendOptions?: { skipPreflight?: boolean }; }) {
  const liveTrades = String(process.env.LIVE_TRADES || '').toLowerCase() === 'true';
  const confirmSend = String(process.env.CONFIRM_SEND || '').toLowerCase() === 'yes';
  if (!liveTrades || !confirmSend) {
    console.warn('[manualSendRawTransactionVerbose] DRY-RUN: live sends disabled. Skipping manual send.');
    return { success: false, reason: 'dry-run' };
  }
  try {
    const options = sendOptions || { skipPreflight: true };
    const highPriority = String(process.env.HIGH_PRIORITY || '').toLowerCase() === 'true' || (options && (options as any).highPriority);
    console.log('[manualSendRawTransactionVerbose] broadcasting raw transaction with options:', options, 'highPriority=', highPriority);
    // prefer fast RPC if requested
    if (highPriority) {
      const prefer = process.env.HIGH_PRIORITY_RPC_URL || process.env.HELIUS_FAST_RPC_URL_2 || (rpcPool.getHealthyCandidates && rpcPool.getHealthyCandidates()[0]);
      if (prefer) {
        try {
          const fastConn = rpcPool.getRpcConnection(prefer);
          const txid = await fastConn.sendRawTransaction(serializedTransaction, options);
          console.log('[manualSendRawTransactionVerbose] sent via fastConn:', prefer, txid);
          connection = fastConn;
          // continue to confirm below
        } catch (e) {
          console.warn('[manualSendRawTransactionVerbose] fast send failed, falling back:', (e as any)?.message ?? e);
        }
      }
    }
    const txid = await connection.sendRawTransaction(serializedTransaction, options);
    console.log('[manualSendRawTransactionVerbose] sendRawTransaction returned signature:', txid);
    // Poll status a few times
    for (let i = 0; i < 12; i++) {
      try {
        const status = await connection.getSignatureStatuses([txid], { searchTransactionHistory: true });
        console.log(`[manualSendRawTransactionVerbose] poll #${i+1} status:`, JSON.stringify(status && status.value ? status.value[0] : null));
        const s = status && status.value && status.value[0];
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          console.log('[manualSendRawTransactionVerbose] Transaction confirmed:', txid);
          return { success: true, txid };
        }
        if (s && s.err) {
          console.warn('[manualSendRawTransactionVerbose] Transaction returned error in status:', s.err);
          return { success: false, reason: s.err, txid };
        }
      } catch (e) {
        console.warn('[manualSendRawTransactionVerbose] poll error:', (e as any)?.message ?? e);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    console.warn('[manualSendRawTransactionVerbose] polling timed out without confirmation');
    return { success: false, reason: 'timeout', txid };
  } catch (e) {
    console.error('[manualSendRawTransactionVerbose] sendRawTransaction failed:', (e as any)?.message ?? e);
    return { success: false, reason: (e as any)?.message ?? e };
  }
}