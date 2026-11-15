// BlazePay pure logic — no DOM, no network. Unit-tested in tests/blaze.test.mjs.
// (libauth below is a pure crypto/address codec — the same library the
// WizardConnect SDK itself is built on; still no DOM, no network.)
import { hash160, encodeCashAddress } from '@bitauth/libauth';

// ---------------------------------------------------------------- CashAddr
// LIGHT validation only: prefix, length and charset. This is NOT a full
// checksum (BCH cashaddr polymod) verification — the UI labels it as such.
const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export function normalizeCashAddr(input) {
  if (typeof input !== 'string') return '';
  let a = input.trim().toLowerCase();
  if (a.startsWith('bitcoincash:')) a = a.slice('bitcoincash:'.length);
  return a;
}

export function withPrefix(bare) {
  return 'bitcoincash:' + normalizeCashAddr(bare);
}

/** Returns { ok, bare, reason } — light format validation only. */
export function validateCashAddr(input) {
  const bare = normalizeCashAddr(input);
  if (!bare) return { ok: false, bare, reason: 'Address is empty.' };
  if (/^(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(bare)) {
    return { ok: false, bare, reason: 'That looks like a legacy BTC-style address. BlazePay needs a CashAddr (bitcoincash:q… / p… / z…).' };
  }
  if (bare.length !== 42) {
    return { ok: false, bare, reason: `CashAddr should be 42 characters after the prefix (got ${bare.length}).` };
  }
  if (!/^[qpz]/.test(bare)) {
    return { ok: false, bare, reason: 'CashAddr must start with q, p or z.' };
  }
  for (const ch of bare) {
    if (!CASHADDR_CHARSET.includes(ch)) {
      return { ok: false, bare, reason: `Character "${ch}" is not in the CashAddr charset.` };
    }
  }
  return { ok: true, bare, reason: '' };
}

// ---------------------------------------------------------------- wallet (WizardConnect)
// WizardConnect's hdwalletv1 protocol does NOT hand the dapp ready-made
// addresses: the wallet shares HD xpubs for named paths ("receive", "change",
// "defi", …) and the dapp derives pubkeys itself
// (DappConnectionManager.getPubkey(childIndex, index)). Turning a derived
// pubkey into the payee CashAddr is therefore BlazePay's job:
//
//   pubkey (33-byte compressed / 65-byte uncompressed)
//     -> hash160 (sha256 + ripemd160, via libauth)
//     -> CashAddr encode, type p2pkh, prefix bitcoincash
//
// encodeCashAddress returns { address } in libauth v3 (a bare string in some
// builds) — both shapes are handled. Any failure returns null, never a
// made-up address.

export function pubkeyToCashAddr(pubkey) {
  if (!(pubkey instanceof Uint8Array)) return null;
  if (pubkey.length !== 33 && pubkey.length !== 65) return null;
  try {
    const encoded = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hash160(pubkey) });
    const address = typeof encoded === 'string' ? encoded : encoded?.address;
    if (typeof address !== 'string') return null;
    return validateCashAddr(address).ok ? address : null;
  } catch {
    return null;
  }
}

/** WizardConnect path names in the order BlazePay prefers a payee address from. */
export const WALLET_PATH_PREFERENCE = ['receive', 'change', 'defi'];

/**
 * Pick the best payee address from wallet-derived candidates.
 * candidates = [{ path, index, address }] (address may be bare or prefixed).
 * Preference: "receive" path first, then "change", then "defi", then any
 * other path; within a path, the lowest address index. Candidates whose
 * address fails light CashAddr validation are skipped. Returns the chosen
 * address string exactly as supplied, or null when nothing is usable.
 */
export function pickWalletAddress(candidates) {
  if (!Array.isArray(candidates)) return null;
  const rank = (path) => {
    const i = WALLET_PATH_PREFERENCE.indexOf(typeof path === 'string' ? path.toLowerCase() : '');
    return i === -1 ? WALLET_PATH_PREFERENCE.length : i;
  };
  const usable = candidates.filter(
    (c) => c && typeof c.address === 'string' && validateCashAddr(c.address).ok,
  );
  if (!usable.length) return null;
  usable.sort((a, b) => (rank(a.path) - rank(b.path)) || ((Number(a.index) || 0) - (Number(b.index) || 0)));
  return usable[0].address;
}

// ---------------------------------------------------------------- amounts
/** Round a BCH amount to whole satoshis (8 dp), returned as a number. */
export function toSatsPrecision(bch) {
  return Math.round(bch * 1e8) / 1e8;
}

export function bchToSats(bch) {
  return Math.round(bch * 1e8);
}

/** Format BCH for BIP21: up to 8 dp, trailing zeros trimmed. */
export function formatBchAmount(bch) {
  const s = toSatsPrecision(bch).toFixed(8);
  return s.replace(/\.?0+$/, '') || '0';
}

// BlazePay is a global, multi-currency product. FX rates are quoted per USD
// (open.er-api base = USD): fx[CODE] = units of CODE per 1 USD.
export const CURRENCIES = [
  { code: 'USD', symbol: '$', label: 'US Dollar' },
  { code: 'EUR', symbol: '€', label: 'Euro' },
  { code: 'GBP', symbol: '£', label: 'British Pound' },
  { code: 'NGN', symbol: '₦', label: 'Nigerian Naira' },
  { code: 'GHS', symbol: 'GH₵', label: 'Ghanaian Cedi' },
  { code: 'KES', symbol: 'KSh', label: 'Kenyan Shilling' },
];

export function resolveFx(rates) {
  const fx = { ...(rates?.fx || {}) };
  if (fx.USD == null) fx.USD = 1;
  // legacy single-rate shape { usdNgn } still supported
  if (rates?.usdNgn && fx.NGN == null) fx.NGN = rates.usdNgn;
  return fx;
}

/**
 * Convert a fiat amount in any supported currency to BCH.
 * rates = { bchUsd, fx: { USD: 1, EUR: 0.92, NGN: 1352, ... } }
 * Returns null when a needed rate is missing.
 */
export function fiatToBch(amount, currency, rates) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  if (!rates || !rates.bchUsd) return null;
  const perUsd = resolveFx(rates)[currency];
  if (!perUsd) return null;
  return toSatsPrecision(amt / perUsd / rates.bchUsd);
}

// ---------------------------------------------------------------- BIP21
export function buildBip21Uri(invoice) {
  const addr = withPrefix(invoice.address);
  const params = new URLSearchParams();
  params.set('amount', formatBchAmount(invoice.bchAmount));
  if (invoice.name) params.set('label', invoice.name);
  if (invoice.desc) params.set('message', invoice.desc);
  return `${addr}?${params.toString()}`;
}

// ---------------------------------------------------------------- invoice codec
// Invoice is encoded into the shareable link as base64url(JSON). No server.
function bytesToBase64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function encodeInvoice(invoice) {
  const json = JSON.stringify(invoice);
  return bytesToBase64Url(new TextEncoder().encode(json));
}

export function decodeInvoice(payload) {
  const json = new TextDecoder().decode(base64UrlToBytes(payload));
  const inv = JSON.parse(json);
  if (!inv || typeof inv !== 'object') throw new Error('Bad invoice payload');
  if (!inv.address || !inv.bchAmount) throw new Error('Invoice is missing address or amount');
  return inv;
}

export function makeInvoice({ name, desc, amount, currency, address, bchAmount, rates, now }) {
  return {
    v: 1,
    name: name || '',
    desc: desc || '',
    amount: Number(amount),
    currency,
    address: normalizeCashAddr(address),
    bchAmount,
    rate: rates
      ? {
          bchUsd: rates.bchUsd ?? null,
          // snapshot only the rate actually used (plus the USD base) to keep links short
          fx: { USD: 1, ...(resolveFx(rates)[currency] != null ? { [currency]: resolveFx(rates)[currency] } : {}) },
          source: rates.source || 'live',
          at: rates.at || now,
        }
      : { bchUsd: null, fx: { USD: 1 }, source: 'manual', at: now },
    createdAt: now,
  };
}

// ---------------------------------------------------------------- payment detection
/**
 * Decide payment state from Blockchair dashboard snapshots.
 * baseline / current = { receivedSats: number, txids: string[] }
 * candidateTx = optional Blockchair transaction object ({ block_id }) for the new txid.
 * requiredSats derived from invoiceBch. Tolerance: 99.5% of required.
 * Returns { state: 'waiting'|'seen'|'paid', txid?, via? }
 */
export function evaluatePayment(baseline, current, invoiceBch, candidateTx) {
  if (!baseline || !current) return { state: 'waiting' };
  const required = bchToSats(invoiceBch);
  const minAccept = Math.floor(required * 0.995);
  const delta = current.receivedSats - baseline.receivedSats;
  const newTxids = (current.txids || []).filter((t) => !(baseline.txids || []).includes(t));
  if (delta >= minAccept && newTxids.length > 0) {
    const txid = newTxids[0];
    if (candidateTx && typeof candidateTx.block_id === 'number') {
      return candidateTx.block_id === -1
        ? { state: 'seen', txid, via: 'mempool transaction detected' }
        : { state: 'paid', txid, via: 'confirmed transaction detected' };
    }
    return { state: 'paid', txid, via: 'received total increased by the invoice amount' };
  }
  if (newTxids.length > 0 && delta > 0) {
    return { state: 'seen', txid: newTxids[0], via: 'incoming transaction seen, amount not yet sufficient' };
  }
  return { state: 'waiting' };
}

/** Defensively pull { receivedSats, txids } out of a Blockchair dashboards/address response. */
export function parseAddressDashboard(json) {
  if (!json || !json.data || typeof json.data !== 'object') return null;
  const first = Object.values(json.data)[0];
  if (!first) return null;
  const addr = first.address || {};
  const receivedSats = Number(addr.received ?? first.received ?? 0);
  const txids = Array.isArray(first.transactions) ? first.transactions.slice() : [];
  if (!Number.isFinite(receivedSats)) return null;
  return { receivedSats, txids };
}

// ---------------------------------------------------------------- watcher providers
// Blockchair is the primary watcher source; Haskoin is the fallback, used in
// the SAME polling cycle whenever Blockchair fails for any reason (network
// error, non-200, HTTP 430 IP-blacklist, malformed body). Both APIs are
// keyless and CORS-enabled, so the pay page can call them from the browser.

export function providerLabel(provider) {
  if (provider === 'haskoin') return 'Haskoin fallback';
  if (provider === 'blockchair') return 'Blockchair';
  return null;
}

/** The fallback decision: Haskoin is used iff the Blockchair attempt did not succeed. */
export function shouldUseHaskoinFallback(blockchairOutcome) {
  return !blockchairOutcome || blockchairOutcome.ok !== true;
}

// ---------------------------------------------------------------- Haskoin
// Shapes verified live 14 Nov 2026 against api.haskoin.com (BCH mainnet):
//   GET /bch/address/<bare>/balance ->
//     { address: 'bitcoincash:q…', confirmed: <sats>, unconfirmed: <sats>,
//       utxo: <count>, txs: <count>, received: <sats> }
//     All amounts are satoshi integers. `received` = lifetime total received,
//     `confirmed` / `unconfirmed` = current balance split by confirmation.
//   GET /bch/address/<bare>/transactions/full?limit=N -> JSON array, newest
//   first, of:
//     { txid, size, version, locktime, fee,
//       inputs:  [{ coinbase, txid, output, sigscript, sequence, pkscript,
//                   value, address: 'bitcoincash:…', witness: [] }],
//       outputs: [{ address: 'bitcoincash:…' (absent on OP_RETURN outputs),
//                   pkscript, value: <sats>, spent: <bool>,
//                   spender: null | { txid, input } }],
//       block: { height: <number>, position: <number> } | null (mempool),
//       deleted, time: <unix seconds>, rbf, weight }
//   A confirmed tx carries block.height; a mempool tx has block null/absent.
//   All parsing below is defensive about missing/null block and fields.

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a Haskoin /balance response. Returns null on anything unexpected. */
export function parseHaskoinBalance(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const receivedSats = numOrNull(json.received);
  if (receivedSats == null) return null;
  return {
    receivedSats,
    confirmedSats: numOrNull(json.confirmed),
    unconfirmedSats: numOrNull(json.unconfirmed),
    txCount: numOrNull(json.txs),
  };
}

/**
 * Reduce one Haskoin /transactions/full entry to what the watcher needs:
 * the total sats it pays to `address`, and whether it is confirmed.
 * Returns null when the entry is unusable.
 */
export function parseHaskoinTransaction(tx, address) {
  if (!tx || typeof tx !== 'object') return null;
  if (typeof tx.txid !== 'string' || !tx.txid) return null;
  if (!Array.isArray(tx.outputs)) return null;
  const target = normalizeCashAddr(address);
  if (!target) return null;
  let toAddressSats = 0;
  for (const out of tx.outputs) {
    if (!out || typeof out !== 'object' || !out.address) continue; // e.g. OP_RETURN
    if (normalizeCashAddr(out.address) !== target) continue;
    const v = numOrNull(out.value);
    if (v != null && v > 0) toAddressSats += v;
  }
  const blockHeight = tx.block && typeof tx.block === 'object' ? numOrNull(tx.block.height) : null;
  return {
    txid: tx.txid,
    toAddressSats,
    confirmed: blockHeight != null,
    blockHeight,
    time: numOrNull(tx.time),
  };
}

/**
 * Find the newest transaction paying `address` at least 99.5% of the invoice
 * amount. Options:
 *   stopTxid — a txid marking the start of the watch (e.g. the newest tx when
 *              the baseline was taken); the search stops BEFORE it, so older
 *              payments are never mistaken for this invoice's payment.
 *   sinceSec — ignore transactions older than this unix timestamp (used with
 *              the invoice creation time when no stop marker exists).
 * Returns a parseHaskoinTransaction result, or null.
 */
export function findHaskoinPaymentTx(txs, address, invoiceBch, options = {}) {
  if (!Array.isArray(txs)) return null;
  const { stopTxid = null, sinceSec = null } = options || {};
  const minAccept = Math.floor(bchToSats(invoiceBch) * 0.995);
  if (minAccept <= 0) return null;
  const parsed = [];
  for (const tx of txs) {
    const p = parseHaskoinTransaction(tx, address);
    if (p) parsed.push(p);
  }
  // Haskoin returns newest first already; enforce it (stable for equal times).
  parsed.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  for (const p of parsed) {
    if (stopTxid && p.txid === stopTxid) break;
    if (sinceSec != null && p.time != null && p.time < sinceSec) continue;
    if (p.toAddressSats >= minAccept) return p;
  }
  return null;
}

/**
 * Decide payment state from Haskoin balance snapshots — the Haskoin twin of
 * evaluatePayment, with the same tolerance (99.5%) and state semantics.
 * baseline / current = parseHaskoinBalance results.
 * match = optional findHaskoinPaymentTx result for the paying transaction.
 * Never reports 'paid' on ambiguous data: without a confirmed tx, 'paid'
 * requires the received delta to be fully confirmed — i.e. the unconfirmed
 * balance did not grow. Missing unconfirmed figures downgrade to 'seen'.
 * Returns { state: 'waiting'|'seen'|'paid', txid?, via? }
 */
export function evaluateHaskoinPayment(baseline, current, invoiceBch, match) {
  if (!baseline || !current) return { state: 'waiting' };
  const required = bchToSats(invoiceBch);
  const minAccept = Math.floor(required * 0.995);
  const delta = current.receivedSats - baseline.receivedSats;
  if (match && match.toAddressSats >= minAccept && minAccept > 0) {
    return match.confirmed
      ? { state: 'paid', txid: match.txid, via: 'confirmed transaction detected' }
      : { state: 'seen', txid: match.txid, via: 'mempool transaction detected' };
  }
  if (delta >= minAccept && minAccept > 0) {
    if (current.unconfirmedSats == null || baseline.unconfirmedSats == null) {
      return { state: 'seen', via: 'received total increased by the invoice amount; confirmation not yet verified' };
    }
    if (current.unconfirmedSats - baseline.unconfirmedSats > 0) {
      return { state: 'seen', via: 'payment is still unconfirmed (mempool)' };
    }
    return { state: 'paid', via: 'received total increased by the invoice amount and the increase is confirmed' };
  }
  if (delta > 0) {
    return { state: 'seen', via: 'incoming funds seen, amount not yet sufficient' };
  }
  return { state: 'waiting' };
}
