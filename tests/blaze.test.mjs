// BlazePay logic tests — run with: npm test   (node --test)
// NOTE: EXAMPLE_ADDRESS is a well-known-format *placeholder* (the historic
// Satoshi-era BCH address used in public docs). It is NOT Yahya's wallet and
// must never be used to receive real funds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCashAddr, normalizeCashAddr, withPrefix,
  fiatToBch, formatBchAmount, bchToSats,
  buildBip21Uri, encodeInvoice, decodeInvoice, makeInvoice,
  evaluatePayment, parseAddressDashboard,
  providerLabel, shouldUseHaskoinFallback,
  parseHaskoinBalance, parseHaskoinTransaction, findHaskoinPaymentTx, evaluateHaskoinPayment,
  pubkeyToCashAddr, pickWalletAddress, WALLET_PATH_PREFERENCE,
} from '../src/lib/blaze.js';

const EXAMPLE_ADDRESS = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'; // placeholder only

test('CashAddr light validation accepts q/p/z CashAddr, with or without prefix', () => {
  assert.equal(validateCashAddr(EXAMPLE_ADDRESS).ok, true);
  assert.equal(validateCashAddr('bitcoincash:' + EXAMPLE_ADDRESS).ok, true);
  assert.equal(normalizeCashAddr('bitcoincash:' + EXAMPLE_ADDRESS), EXAMPLE_ADDRESS);
  assert.equal(withPrefix(EXAMPLE_ADDRESS), 'bitcoincash:' + EXAMPLE_ADDRESS);
});

test('CashAddr light validation rejects junk and legacy addresses', () => {
  assert.equal(validateCashAddr('').ok, false);
  assert.equal(validateCashAddr('hello').ok, false);
  assert.equal(validateCashAddr('qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6!').ok, false); // bad char
  assert.equal(validateCashAddr('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').ok, false); // legacy
  assert.equal(validateCashAddr('xpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a').ok, false); // bad first char
});

test('conversion math: multi-currency to BCH via USD-base cross rates', () => {
  // fx = units of currency per 1 USD (open.er-api shape)
  const rates = { bchUsd: 200, fx: { USD: 1, EUR: 0.9, GBP: 0.8, NGN: 1000, GHS: 12, KES: 130 } };
  assert.equal(fiatToBch(100, 'USD', rates), 0.5);
  assert.equal(fiatToBch(90, 'EUR', rates), 0.5); // €90 = $100
  assert.equal(fiatToBch(80, 'GBP', rates), 0.5); // £80 = $100
  assert.equal(fiatToBch(100000, 'NGN', rates), 0.5); // ₦100,000 = $100
  assert.equal(fiatToBch(1200, 'GHS', rates), 0.5);
  assert.equal(fiatToBch(13000, 'KES', rates), 0.5);
  assert.equal(fiatToBch(50, 'USD', rates), 0.25);
  assert.equal(fiatToBch(0, 'USD', rates), null);
  assert.equal(fiatToBch(100, 'USD', { bchUsd: null, fx: { USD: 1 } }), null);
  assert.equal(fiatToBch(100, 'NGN', { bchUsd: 200, fx: { USD: 1 } }), null); // missing NGN rate
  // legacy single-rate shape still works
  assert.equal(fiatToBch(100000, 'NGN', { bchUsd: 200, usdNgn: 1000 }), 0.5);
});

test('BCH formatting trims to satoshi precision', () => {
  assert.equal(formatBchAmount(0.5), '0.5');
  assert.equal(formatBchAmount(1), '1');
  assert.equal(formatBchAmount(0.00000001), '0.00000001');
  assert.equal(formatBchAmount(0.123456789), '0.12345679'); // rounded to sats
  assert.equal(bchToSats(0.5), 50000000);
});

test('BIP21 URI building', () => {
  const uri = buildBip21Uri({ address: EXAMPLE_ADDRESS, bchAmount: 0.5, name: 'Adaeze', desc: 'Logo design' });
  assert.ok(uri.startsWith('bitcoincash:' + EXAMPLE_ADDRESS + '?'));
  assert.ok(uri.includes('amount=0.5'));
  assert.ok(uri.includes('label=Adaeze'));
  assert.ok(uri.includes('message=Logo+design'));
});

test('invoice encode/decode round-trip (incl. currency symbols and unicode)', () => {
  const inv = makeInvoice({
    name: 'Yahya — € test ✦', desc: 'Payment for work — ₦, £, KSh', amount: 50000, currency: 'NGN',
    address: 'bitcoincash:' + EXAMPLE_ADDRESS, bchAmount: 0.25,
    rates: { bchUsd: 200, fx: { USD: 1, NGN: 1000 }, at: 1700000000000 }, now: 1700000000000,
  });
  const payload = encodeInvoice(inv);
  assert.match(payload, /^[A-Za-z0-9\-_]+$/); // base64url, URL-safe
  const back = decodeInvoice(payload);
  assert.deepEqual(back, inv);
  assert.equal(back.address, EXAMPLE_ADDRESS); // prefix stripped in storage
});

test('payment evaluation: waiting → seen (mempool) → paid (confirmed)', () => {
  const inv = 0.5; // BCH
  const base = { receivedSats: 1000, txids: ['oldtx'] };
  assert.equal(evaluatePayment(base, { receivedSats: 1000, txids: ['oldtx'] }, inv).state, 'waiting');
  const seen = evaluatePayment(base, { receivedSats: 1000 + 50000000, txids: ['newtx', 'oldtx'] }, inv, { block_id: -1 });
  assert.equal(seen.state, 'seen');
  assert.equal(seen.txid, 'newtx');
  const paid = evaluatePayment(base, { receivedSats: 1000 + 50000000, txids: ['newtx', 'oldtx'] }, inv, { block_id: 900000 });
  assert.equal(paid.state, 'paid');
  // tolerance: 99.5% of required still counts; 90% does not reach paid
  const almost = evaluatePayment(base, { receivedSats: 1000 + Math.floor(50000000 * 0.996), txids: ['newtx', 'oldtx'] }, inv);
  assert.equal(almost.state, 'paid');
  const short = evaluatePayment(base, { receivedSats: 1000 + 45000000, txids: ['newtx', 'oldtx'] }, inv);
  assert.equal(short.state, 'seen');
});

test('Blockchair dashboard parsing is defensive', () => {
  const sample = { data: { [EXAMPLE_ADDRESS]: { address: { received: 12345, balance: 100 }, transactions: ['a', 'b'] } } };
  assert.deepEqual(parseAddressDashboard(sample), { receivedSats: 12345, txids: ['a', 'b'] });
  assert.equal(parseAddressDashboard({ data: null }), null);
  assert.equal(parseAddressDashboard({}), null);
  assert.equal(parseAddressDashboard(null), null);
});

// ------------------------------------------------------------- Haskoin (watcher v2)
// Fixtures mirror the live api.haskoin.com shapes verified 14 Nov 2026:
// balance amounts are satoshi integers; tx outputs carry a prefixed
// `address` + satoshi `value`; a confirmed tx has block { height, position },
// a mempool tx has block: null.
const HK_ADDR = 'bitcoincash:' + EXAMPLE_ADDRESS;
const hkBalance = (over = {}) => ({
  address: HK_ADDR, confirmed: 100000, unconfirmed: 0, utxo: 3, txs: 7, received: 500000, ...over,
});
const hkTx = ({ txid, pays = [], block = { height: 900000, position: 3 }, time = 1790000000 }) => ({
  txid, size: 226, version: 2, locktime: 0, fee: 227,
  inputs: [{ coinbase: false, txid: 'aa'.repeat(32), output: 1, sigscript: '48', sequence: 4294967293, pkscript: '76a9', value: 999999999, address: 'bitcoincash:qplwfa57v5y4wya6750u25l29fmkm3v94g6zwperhv', witness: [] }],
  outputs: [
    ...pays.map((value) => ({ address: HK_ADDR, pkscript: '76a9', value, spent: false, spender: null })),
    { address: 'bitcoincash:qrdgpe3cefys3kyv5eukptj2494mjhsnssmhdzj8e0', pkscript: '76a9', value: 12345, spent: true, spender: { txid: 'bb'.repeat(32), input: 0 } },
    { pkscript: '6a04deadbeef', value: 0, spent: false, spender: null }, // OP_RETURN: no address
  ],
  block, deleted: false, time, rbf: false, weight: 904,
});

test('Haskoin balance parsing (satoshi integers, defensive)', () => {
  assert.deepEqual(parseHaskoinBalance(hkBalance()),
    { receivedSats: 500000, confirmedSats: 100000, unconfirmedSats: 0, txCount: 7 });
  assert.deepEqual(parseHaskoinBalance({ address: HK_ADDR, received: 42 }),
    { receivedSats: 42, confirmedSats: null, unconfirmedSats: null, txCount: null });
  assert.equal(parseHaskoinBalance(null), null);
  assert.equal(parseHaskoinBalance([]), null);
  assert.equal(parseHaskoinBalance({ address: HK_ADDR }), null); // no received
  assert.equal(parseHaskoinBalance({ received: 'lots' }), null);
});

test('Haskoin transaction parsing: output matching + block marker classification', () => {
  const confirmed = parseHaskoinTransaction(hkTx({ txid: 'tx1', pays: [30000, 25000] }), EXAMPLE_ADDRESS);
  assert.equal(confirmed.toAddressSats, 55000); // both outputs to the address summed; change + OP_RETURN ignored
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.blockHeight, 900000);
  assert.equal(confirmed.txid, 'tx1');
  const mempool = parseHaskoinTransaction(hkTx({ txid: 'tx2', pays: [55000], block: null }), EXAMPLE_ADDRESS);
  assert.equal(mempool.confirmed, false);
  assert.equal(mempool.blockHeight, null);
  const noBlockField = hkTx({ txid: 'tx3', pays: [1] });
  delete noBlockField.block;
  assert.equal(parseHaskoinTransaction(noBlockField, EXAMPLE_ADDRESS).confirmed, false); // missing block = not confirmed
  const otherAddress = parseHaskoinTransaction(hkTx({ txid: 'tx4', pays: [55000] }), 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b');
  assert.equal(otherAddress.toAddressSats, 0); // pays a different address
  assert.equal(parseHaskoinTransaction(null, EXAMPLE_ADDRESS), null);
  assert.equal(parseHaskoinTransaction({ txid: 'tx5' }, EXAMPLE_ADDRESS), null); // no outputs array
  assert.equal(parseHaskoinTransaction({ outputs: [] }, EXAMPLE_ADDRESS), null); // no txid
});

test('Haskoin payment-tx search: threshold, newest first, stop marker, time filter', () => {
  const inv = 0.00055; // 55,000 sats; minAccept = 54,725
  const older = hkTx({ txid: 'oldbig', pays: [60000], time: 1780000000 });
  const stop = hkTx({ txid: 'basetx', pays: [60000], time: 1785000000 });
  const small = hkTx({ txid: 'newsmall', pays: [10000], time: 1790000000 });
  const big = hkTx({ txid: 'newbig', pays: [56000], block: null, time: 1790001000 });
  // newest matching wins
  assert.equal(findHaskoinPaymentTx([big, small, stop, older], EXAMPLE_ADDRESS, inv).txid, 'newbig');
  // nothing at/above threshold after the baseline marker -> null (old payments ignored)
  assert.equal(findHaskoinPaymentTx([small, stop, older], EXAMPLE_ADDRESS, inv, { stopTxid: 'basetx' }), null);
  // without the marker the older payment would match — the marker is what protects us
  assert.equal(findHaskoinPaymentTx([small, older], EXAMPLE_ADDRESS, inv).txid, 'oldbig');
  // time filter (invoice lifetime) also excludes pre-invoice payments
  assert.equal(findHaskoinPaymentTx([older], EXAMPLE_ADDRESS, inv, { sinceSec: 1786000000 }), null);
  assert.equal(findHaskoinPaymentTx([big], EXAMPLE_ADDRESS, inv, { sinceSec: 1786000000 }).txid, 'newbig');
  assert.equal(findHaskoinPaymentTx('nope', EXAMPLE_ADDRESS, inv), null);
  assert.equal(findHaskoinPaymentTx([], EXAMPLE_ADDRESS, inv), null);
});

test('Haskoin payment evaluation: waiting → seen (mempool) → paid (confirmed)', () => {
  const inv = 0.5; // 50,000,000 sats
  const base = parseHaskoinBalance(hkBalance());
  // no movement -> waiting
  assert.equal(evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance()), inv).state, 'waiting');
  // matching mempool tx (block: null) -> seen, with txid
  const mempoolMatch = parseHaskoinTransaction(hkTx({ txid: 'mempooltx', pays: [50000000], block: null }), EXAMPLE_ADDRESS);
  const seen = evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 50000000, unconfirmed: 50000000 })), inv, mempoolMatch);
  assert.equal(seen.state, 'seen');
  assert.equal(seen.txid, 'mempooltx');
  // matching confirmed tx -> paid
  const confMatch = parseHaskoinTransaction(hkTx({ txid: 'conftx', pays: [50000000] }), EXAMPLE_ADDRESS);
  const paid = evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 50000000, confirmed: 50100000 })), inv, confMatch);
  assert.equal(paid.state, 'paid');
  assert.equal(paid.txid, 'conftx');
  // no tx found, delta arrived but is still unconfirmed -> seen (never paid on ambiguity)
  const unconf = evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 50000000, unconfirmed: 50000000 })), inv, null);
  assert.equal(unconf.state, 'seen');
  // no tx found, delta arrived and unconfirmed balance did not grow -> fully confirmed -> paid
  const conf = evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 50000000, confirmed: 50100000 })), inv, null);
  assert.equal(conf.state, 'paid');
  // no tx found and unconfirmed figures missing -> ambiguous -> seen
  const ambig = evaluateHaskoinPayment({ receivedSats: 500000, unconfirmedSats: null }, { receivedSats: 500000 + 50000000, unconfirmedSats: null }, inv, null);
  assert.equal(ambig.state, 'seen');
  // partial payment -> seen, not paid
  const partial = evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 10000000, unconfirmed: 10000000 })), inv, null);
  assert.equal(partial.state, 'seen');
  // tolerance: 99.6% via a matching tx still counts
  const almostMatch = parseHaskoinTransaction(hkTx({ txid: 'almost', pays: [Math.floor(50000000 * 0.996)] }), EXAMPLE_ADDRESS);
  assert.equal(evaluateHaskoinPayment(base, parseHaskoinBalance(hkBalance({ received: 500000 + 49800000 })), inv, almostMatch).state, 'paid');
});

// ------------------------------------------------------------- WizardConnect wallet
// Pubkey vectors are the generator point G (private key 1) in compressed and
// uncompressed form. Expected CashAddrs were produced with libauth's
// hash160 + encodeCashAddress and the compressed one's checksum was verified
// against an independent implementation of the CashAddr spec polymod.
const G_COMPRESSED = Uint8Array.from(Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));
const G_UNCOMPRESSED = Uint8Array.from(Buffer.from('0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8', 'hex'));

test('pubkeyToCashAddr derives the payee P2PKH CashAddr from a wallet pubkey', () => {
  assert.equal(pubkeyToCashAddr(G_COMPRESSED), 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h');
  assert.equal(pubkeyToCashAddr(G_UNCOMPRESSED), 'bitcoincash:qzgmyjle755g2v5kptrg02asx5f8k8fg55zdx7hd4l');
  // derived addresses pass the app's own light validation
  assert.equal(validateCashAddr(pubkeyToCashAddr(G_COMPRESSED)).ok, true);
  // unusable input -> null, never a fabricated address
  assert.equal(pubkeyToCashAddr(null), null);
  assert.equal(pubkeyToCashAddr(undefined), null);
  assert.equal(pubkeyToCashAddr('0279be66'), null); // string, not bytes
  assert.equal(pubkeyToCashAddr(new Uint8Array(32)), null); // wrong length
  assert.equal(pubkeyToCashAddr(new Uint8Array(64)), null);
  assert.equal(pubkeyToCashAddr([]), null);
});

test('pickWalletAddress prefers receive > change > defi, then lowest index', () => {
  const recv = 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h';
  const other = 'bitcoincash:' + EXAMPLE_ADDRESS;
  assert.deepEqual(WALLET_PATH_PREFERENCE, ['receive', 'change', 'defi']);
  // receive wins even when listed last and at a higher index
  assert.equal(pickWalletAddress([
    { path: 'defi', index: 0, address: other },
    { path: 'change', index: 0, address: other },
    { path: 'receive', index: 3, address: recv },
  ]), recv);
  // within a path, lowest index wins
  assert.equal(pickWalletAddress([
    { path: 'receive', index: 2, address: other },
    { path: 'receive', index: 0, address: recv },
  ]), recv);
  // unknown paths rank after the well-known ones; case-insensitive path names
  assert.equal(pickWalletAddress([
    { path: 'stealth_scan', index: 0, address: other },
    { path: 'Change', index: 0, address: recv },
  ]), recv);
  // invalid addresses are skipped, even on the preferred path
  assert.equal(pickWalletAddress([
    { path: 'receive', index: 0, address: 'not-an-address' },
    { path: 'change', index: 0, address: other },
  ]), other);
  // nothing usable -> null
  assert.equal(pickWalletAddress([]), null);
  assert.equal(pickWalletAddress(null), null);
  assert.equal(pickWalletAddress([{ path: 'receive', index: 0, address: '' }]), null);
  assert.equal(pickWalletAddress([{ path: 'receive', index: 0 }]), null);
});

test('watcher fallback decision: any Blockchair failure routes to Haskoin', () => {
  assert.equal(shouldUseHaskoinFallback({ ok: true }), false);
  assert.equal(shouldUseHaskoinFallback({ ok: false }), true); // e.g. HTTP 430
  assert.equal(shouldUseHaskoinFallback(null), true); // network error / no result
  assert.equal(shouldUseHaskoinFallback(undefined), true);
  assert.equal(shouldUseHaskoinFallback({}), true);
  assert.equal(providerLabel('blockchair'), 'Blockchair');
  assert.equal(providerLabel('haskoin'), 'Haskoin fallback');
  assert.equal(providerLabel('nope'), null);
});
