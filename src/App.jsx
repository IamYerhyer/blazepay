import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { childIndexOfPathName } from '@wizardconnect/core';
import {
  CURRENCIES, validateCashAddr, withPrefix, fiatToBch, formatBchAmount, bchToSats,
  buildBip21Uri, encodeInvoice, decodeInvoice, makeInvoice,
  evaluatePayment, parseAddressDashboard,
  providerLabel, shouldUseHaskoinFallback,
  parseHaskoinBalance, findHaskoinPaymentTx, evaluateHaskoinPayment,
  pubkeyToCashAddr, pickWalletAddress, WALLET_PATH_PREFERENCE,
} from './lib/blaze.js';
import bchLogo from './assets/bch-logo.svg';

// ------------------------------------------------------------------ prices
function usePrices() {
  const [state, setState] = useState({ status: 'loading', bchUsd: null, fx: null, at: null });
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [cg, fxRes] = await Promise.all([
          fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd'),
          fetch('https://open.er-api.com/v6/latest/USD'),
        ]);
        const cgJson = await cg.json();
        const fxJson = await fxRes.json();
        const bchUsd = cgJson?.['bitcoin-cash']?.usd ?? null;
        const fx = fxJson?.rates ?? null;
        if (!dead) {
          if (bchUsd && fx) setState({ status: 'live', bchUsd, fx, at: Date.now() });
          else setState({ status: 'error', bchUsd, fx, at: null });
        }
      } catch {
        if (!dead) setState({ status: 'error', bchUsd: null, fx: null, at: null });
      }
    })();
    return () => { dead = true; };
  }, []);
  return state;
}

const fmtFiat = (n, code) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n); }
  catch { return `${code} ${Number(n).toLocaleString()}`; }
};

// ------------------------------------------------------------------ chrome
function HackathonBanner() {
  return (
    <div className="hack-banner">
      <span className="hack-banner-label">🏆 Built for BCH BLAZE 2026</span>
      {/* TODO placeholders — deliberately non-functional until the real links exist */}
      <a href="#" onClick={(e) => e.preventDefault()} title="TODO: link the Widget Factory presentation">Presentation (TODO)</a>
      <span className="hack-dot">·</span>
      <a href="https://github.com/IamYerhyer/blazepay" target="_blank" rel="noreferrer" title="BlazePay source code on GitHub">GitHub repo</a>
      <span className="hack-dot">·</span>
      <a href="https://blockchair.com/bitcoin-cash/address/zzut2fpekspep63v74ar30hc9xknpw3evveamyudff" target="_blank" rel="noreferrer" title="EMBER2026 donations — CashTokens address bitcoincash:zzut2fpekspep63v74ar30hc9xknpw3evveamyudff">EMBER2026 donations: <em>bitcoincash:zzut2f…amyudff</em></a>
    </div>
  );
}

function TopBar() {
  return (
    <header className="topbar">
      <a className="wordmark" href="#/">BlazePay<sup>®</sup></a>
      <div className="topbar-right">
        <span className="status-chip"><span className="dot dot-green" /> BCH Mainnet — live</span>
        <details className="menu">
          <summary className="menu-btn">Menu</summary>
          <nav className="menu-pop">
            <a href="#create">Create a payment link</a>
            <a href="#how">How it works</a>
            <a href="#/">Home</a>
          </nav>
        </details>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ wallet connect (WizardConnect)
// All WizardConnect configuration lives here. The SDK (hdwalletv1 over Nostr
// relays) has no WalletConnect-style projectId and no metadata object: the
// only dapp identity it sends in `dapp_ready` is the name + icon below.
// dappUrl is kept here as the canonical site URL for reference.
const WIZARDCONNECT_CONFIG = {
  dappName: 'BlazePay',
  dappUrl: 'https://iamyerhyer.github.io/blazepay/',
  dappIcon: 'https://iamyerhyer.github.io/blazepay/favicon.svg',
};

/**
 * Read the connected wallet's addresses from a DappConnectionManager.
 * The wallet shares xpubs for named paths (getSessionPaths); the manager
 * derives pubkeys on demand (getPubkey). Paths the wallet did not announce
 * are still attempted for the well-known names — getPubkey simply returns
 * undefined when no xpub is stored for that child index.
 * Returns [{ path, index, address }] with full bitcoincash: addresses.
 */
function collectWalletCandidates(manager) {
  const candidates = [];
  if (!manager) return candidates;
  let names = [];
  try {
    names = (manager.getSessionPaths() || []).map((p) => p?.name).filter(Boolean);
  } catch { names = []; }
  for (const name of WALLET_PATH_PREFERENCE) {
    if (!names.includes(name)) names.push(name);
  }
  for (const name of names) {
    const child = childIndexOfPathName(name);
    if (child == null) continue;
    let pub = null;
    try { pub = manager.getPubkey(child, 0n); } catch { pub = null; }
    if (!pub) continue;
    const address = pubkeyToCashAddr(pub);
    if (address) candidates.push({ path: name, index: 0, address });
  }
  return candidates;
}

const shortAddr = (a) => (a && a.length > 34 ? `${a.slice(0, 24)}…${a.slice(-8)}` : a);

// If anything inside the connect panel ever throws, the create form below it
// must stay fully usable — wallet connect is a convenience, never a gate.
class ConnectPanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* panel-only failure; manual paste below still works */ }
  render() {
    if (this.state.failed) {
      return (
        <div className="connect-panel">
          <p><strong>Wallet connect isn't available in this browser.</strong> No problem — just paste your CashAddr below.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function WalletConnectPanel({ address, onWalletAddress, onApplyWalletAddress, onWalletDisconnect }) {
  const { state, manager, uri, qrUri, walletName, walletIcon, connect, disconnect, error } =
    useWizardConnect({ dappName: WIZARDCONNECT_CONFIG.dappName, dappIcon: WIZARDCONNECT_CONFIG.dappIcon });

  // Derive the wallet's payee address straight from the session state —
  // recomputed only when the session (manager) changes. A connected wallet
  // whose xpubs yield no usable address is an honest failure, not a fake fill.
  const derived = useMemo(() => {
    if (state !== 'connected' || !manager) return { address: null, failed: false };
    const picked = pickWalletAddress(collectWalletCandidates(manager));
    return picked ? { address: picked, failed: false } : { address: null, failed: true };
  }, [state, manager]);
  const walletAddress = derived.address;
  const readError = derived.failed
    ? 'Connected, but no BCH address could be read from this wallet — please paste your CashAddr below.'
    : '';

  // Hand the address up to the form exactly once per session (per manager).
  const filledForRef = useRef(null);
  useEffect(() => {
    if (state === 'idle' || state === 'disconnected') { filledForRef.current = null; return; }
    if (!walletAddress || !manager) return;
    if (filledForRef.current === manager) return;
    filledForRef.current = manager;
    onWalletAddress(walletAddress);
  }, [state, manager, walletAddress, onWalletAddress]);

  // Soft timeout: after 90s of waiting, hint that the wallet app needs a
  // look — the session itself is left alone (the dialog stays closable).
  // The start time is stamped by the Connect button's click handler; a
  // 5-second interval tick keeps the hint current while waiting.
  const [connectStartedAt, setConnectStartedAt] = useState(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (state !== 'connecting') return undefined;
    const t = setInterval(() => setNowTs(Date.now()), 5000);
    return () => clearInterval(t);
  }, [state]);
  const slowWait = state === 'connecting' && connectStartedAt != null
    && nowTs - connectStartedAt >= 90000;

  async function handleDisconnect() {
    onWalletDisconnect();
    await disconnect();
  }

  if (state === 'connected') {
    return (
      <div className="connect-panel">
        {typeof walletIcon === 'string' && /^(data:|https?:)/.test(walletIcon)
          ? <img className="connect-wallet-icon" src={walletIcon} alt="" />
          : <span className="dot dot-green" />}
        <div className="connect-main">
          <p>
            <strong>Connected{walletName ? ` to ${walletName}` : ' to your wallet'}</strong>
            {walletAddress && <> · <span className="connect-addr" title={walletAddress}>{shortAddr(walletAddress)}</span></>}
          </p>
          {readError && <p className="field-err">{readError}</p>}
          {!walletAddress && !readError && <p>Reading your receive address…</p>}
          {walletAddress && address !== walletAddress && (
            <p>Your wallet's address is ready — <button type="button" className="linklike" onClick={() => onApplyWalletAddress(walletAddress)}>use this address</button> in the form below.</p>
          )}
          {walletAddress && address === walletAddress && <p>Your CashAddr below was filled from your wallet. You can still edit it.</p>}
        </div>
        <button type="button" className="btn btn-white" onClick={handleDisconnect}>Disconnect</button>
      </div>
    );
  }

  if (state === 'connecting' || state === 'reconnecting') {
    return (
      <div className="connect-panel">
        <span className="dot dot-amber pulse" />
        <div className="connect-main">
          <p>
            <strong>{state === 'reconnecting' ? 'Reconnecting to your wallet…' : 'Waiting for your wallet…'}</strong>{' '}
            {state === 'connecting' ? 'Scan the QR code with Paytaca or Cashonize and approve the connection.' : 'Restoring your earlier session.'}
          </p>
          {slowWait && <p>Still waiting — open your wallet app and approve the connection, or close the QR dialog and paste your CashAddr below instead.</p>}
        </div>
        <button type="button" className="btn btn-white" onClick={handleDisconnect}>Cancel</button>
        {uri && qrUri && (
          <WizardConnectQRDialog
            show={state === 'connecting'}
            onClose={handleDisconnect}
            uri={uri}
            qrUri={qrUri}
            title="Connect with WizardConnect"
            subtitle="Scan with Paytaca or Cashonize to connect"
            theme={{
              dialogBackground: '#ffffff', headerBackground: '#ffffff',
              titleColor: '#131311', subtitleColor: '#6f6e66',
              qrForeground: '#0a3d22', qrBackground: '#ffffff',
              uriRowBackground: '#f6f5f0', uriTextColor: '#6f6e66',
              borderColor: '#e7e4da', closeButtonColor: '#6f6e66', copyButtonColor: '#07853e',
            }}
          />
        )}
      </div>
    );
  }

  // idle / disconnected
  return (
    <div className="connect-panel">
      <button type="button" className="btn btn-white" onClick={() => { setConnectStartedAt(Date.now()); connect(); }}>
        <span className="dot dot-green" /> Connect wallet
      </button>
      <div className="connect-main">
        <p><strong>Connect a BCH wallet</strong> (Paytaca, Cashonize) with WizardConnect and BlazePay fills in your address automatically. Prefer not to? Just paste your CashAddr below — no account, no sign-up.</p>
        {error && <p className="field-err">Wallet connection didn't complete ({error}) — paste your CashAddr below instead.</p>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ create
function CreateForm({ prices, onCreated }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [address, setAddress] = useState('');
  const [manualBch, setManualBch] = useState('');
  const [error, setError] = useState('');
  // The exact string the wallet last filled into the address field. Used to
  // (a) avoid overwriting an address the user typed by hand, and (b) clear
  // the field on disconnect only while it still holds the wallet's value.
  const [walletFilled, setWalletFilled] = useState(null);

  const handleWalletAddress = useCallback((picked) => {
    // Fill only an empty field (or one still holding the previous wallet
    // value). If the user typed a different address by hand, leave it — the
    // panel offers a "use this address" button for the wallet's address.
    if (!address || address === walletFilled) {
      setWalletFilled(picked);
      setAddress(picked);
    }
  }, [address, walletFilled]);

  const handleApplyWalletAddress = useCallback((picked) => {
    setWalletFilled(picked);
    setAddress(picked);
  }, []);

  const handleWalletDisconnect = useCallback(() => {
    // Clear the field only while it still holds the wallet-filled value.
    if (walletFilled && address === walletFilled) setAddress('');
    setWalletFilled(null);
  }, [address, walletFilled]);

  const addrCheck = useMemo(() => (address ? validateCashAddr(address) : null), [address]);
  const liveBch = useMemo(
    () => (prices.bchUsd && prices.fx ? fiatToBch(amount, currency, { bchUsd: prices.bchUsd, fx: prices.fx }) : null),
    [amount, currency, prices],
  );
  const manual = Number(manualBch);
  const manualOk = manualBch !== '' && Number.isFinite(manual) && manual > 0;
  const effectiveBch = manualOk ? manual : liveBch;

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setError('Add your name or business name.');
    if (!amount || Number(amount) <= 0) return setError('Enter an amount greater than zero.');
    if (!addrCheck?.ok) return setError(addrCheck?.reason || 'Enter your BCH CashAddr.');
    if (!effectiveBch) return setError('Live rate unavailable and no manual BCH amount entered — add a BCH amount manually below.');
    const inv = makeInvoice({
      name: name.trim(), desc: desc.trim(), amount: Number(amount), currency,
      address, bchAmount: effectiveBch,
      rates: manualOk ? null : { bchUsd: prices.bchUsd, fx: prices.fx, source: 'live', at: prices.at },
      now: Date.now(),
    });
    setError('');
    onCreated(inv);
  }

  return (
    <section className="section" id="create">
      <h2 className="section-title">Create a payment link</h2>
      <p className="section-sub">Price it in USD, EUR, GBP, NGN, GHS, KES and more — your payer settles in BCH.</p>

      <ConnectPanelBoundary>
        <WalletConnectPanel
          address={address}
          onWalletAddress={handleWalletAddress}
          onApplyWalletAddress={handleApplyWalletAddress}
          onWalletDisconnect={handleWalletDisconnect}
        />
      </ConnectPanelBoundary>

      <form className="form" onSubmit={submit}>
        <label>Your name or business
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Adaeze Designs" />
        </label>
        <label>What is it for?
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Logo design, invoice #12" />
        </label>
        <div className="form-row">
          <label>Amount
            <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50" />
          </label>
          <label>Currency
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </label>
        </div>
        <label>Your Bitcoin Cash address (CashAddr)
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bitcoincash:q…" spellCheck="false" />
        </label>
        {address && (
          <p className={addrCheck.ok ? 'field-ok' : 'field-err'}>
            {addrCheck.ok ? '✓ Address format looks good (light format check only — double-check it in your wallet).' : addrCheck.reason}
          </p>
        )}
        <div className="rate-box">
          {prices.status === 'loading' && <p>Fetching live rates…</p>}
          {prices.status === 'error' && <p className="field-err">Live rate unavailable right now — enter the BCH amount manually below.</p>}
          {prices.status === 'live' && (
            <p>
              Live rate: 1 BCH = ${prices.bchUsd.toLocaleString()}
              {prices.fx[currency] && currency !== 'USD' ? <> · 1 USD = {prices.fx[currency].toLocaleString()} {currency}</> : null}
              {liveBch ? <> · <strong>{fmtFiat(Number(amount) || 0, currency)} ≈ {formatBchAmount(liveBch)} BCH</strong></> : null}
            </p>
          )}
          <label>Manual BCH amount (optional override — required if the live rate fails)
            <input type="number" min="0" step="any" value={manualBch} onChange={(e) => setManualBch(e.target.value)} placeholder="e.g. 0.25" />
          </label>
        </div>
        {error && <p className="field-err">{error}</p>}
        <button className="btn btn-black btn-big" type="submit">Create my link →</button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ pay page
function usePaymentWatcher(invoice) {
  const [snap, setSnap] = useState({ phase: 'waiting', txid: null, via: null, source: null, note: 'Starting watcher…' });
  const baselineRef = useRef(null); // { provider, snapshot, newestTxid }
  const latchedRef = useRef(null); // best result so far — never downgraded
  useEffect(() => {
    let dead = false;
    let timer;
    const bare = invoice.address;
    const minAcceptSats = Math.floor(bchToSats(invoice.bchAmount) * 0.995);
    // Haskoin tx searches are limited to this invoice's lifetime (2 min slack
    // for clock skew) whenever no stronger stop-marker is available.
    const sinceSec = Math.floor((invoice.createdAt || Date.now()) / 1000) - 120;

    const bcUrl = `https://api.blockchair.com/bitcoin-cash/dashboards/address/${bare}`;
    const hkBalanceUrl = `https://api.haskoin.com/bch/address/${bare}/balance`;
    const hkTxsUrl = `https://api.haskoin.com/bch/address/${bare}/transactions/full?limit=25`;

    // Latch the best state seen: paid never falls back to seen/waiting, and a
    // provider switch can never lose an already-detected payment. `source`
    // always reflects the provider behind the latest successful check.
    function publish(result, source) {
      const rank = { waiting: 0, seen: 1, paid: 2 };
      const prev = latchedRef.current;
      if (!prev || rank[result.state] > rank[prev.phase]) {
        latchedRef.current = { phase: result.state, txid: result.txid || null, via: result.via || null };
      } else if (rank[result.state] === rank[prev.phase] && result.txid && !prev.txid) {
        latchedRef.current = { ...prev, txid: result.txid, via: result.via || prev.via };
      }
      if (dead) return;
      const best = latchedRef.current;
      setSnap({
        phase: best.phase, txid: best.txid, via: best.via, source,
        note: best.phase === 'waiting' ? 'Watching this address on BCH mainnet…' : null,
      });
    }

    async function fetchBlockchairSnapshot() {
      const res = await fetch(bcUrl);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`Blockchair HTTP ${res.status}`);
      if (json?.context?.code && json.context.code !== 200) {
        throw new Error(json.context.error || `Blockchair code ${json.context.code}`);
      }
      const parsed = parseAddressDashboard(json);
      if (!parsed) throw new Error('Unexpected Blockchair response');
      return parsed;
    }

    async function fetchBlockchairCandidateTx(txid) {
      const txRes = await fetch(`https://api.blockchair.com/bitcoin-cash/dashboards/transaction/${txid}`);
      const txJson = await txRes.json().catch(() => null);
      return txJson?.data?.[txid]?.transaction || null;
    }

    async function fetchHaskoinBalance() {
      const res = await fetch(hkBalanceUrl);
      if (!res.ok) throw new Error(`Haskoin HTTP ${res.status}`);
      const parsed = parseHaskoinBalance(await res.json().catch(() => null));
      if (!parsed) throw new Error('Unexpected Haskoin response');
      return parsed;
    }

    async function fetchHaskoinMatch(stopTxid) {
      const res = await fetch(hkTxsUrl);
      if (!res.ok) throw new Error(`Haskoin transactions HTTP ${res.status}`);
      const json = await res.json().catch(() => null);
      if (!Array.isArray(json)) throw new Error('Unexpected Haskoin transactions response');
      return findHaskoinPaymentTx(json, bare, invoice.bchAmount, { stopTxid, sinceSec });
    }

    // Best-effort marker of the newest tx when a Haskoin baseline is taken, so
    // later tx searches never mistake an older payment for this invoice's.
    async function fetchHaskoinNewestTxid() {
      try {
        const res = await fetch(`https://api.haskoin.com/bch/address/${bare}/transactions/full?limit=1`);
        if (!res.ok) return null;
        const json = await res.json().catch(() => null);
        return Array.isArray(json) && typeof json[0]?.txid === 'string' ? json[0].txid : null;
      } catch { return null; }
    }

    async function handleBlockchair(parsed) {
      const source = providerLabel('blockchair');
      const base = baselineRef.current;
      if (!base) {
        baselineRef.current = { provider: 'blockchair', snapshot: parsed, newestTxid: null };
        publish({ state: 'waiting' }, source);
        return;
      }
      if (base.provider !== 'blockchair') {
        // Provider switch: Blockchair recovered after Haskoin baselined us.
        // Surface a payment that landed during the outage via the Haskoin tx
        // search, then re-baseline on Blockchair for like-for-like compares.
        let surfaced = false;
        try {
          const match = await fetchHaskoinMatch(base.newestTxid || null);
          if (match) {
            publish(
              evaluateHaskoinPayment(base.snapshot,
                { ...base.snapshot, receivedSats: base.snapshot.receivedSats + match.toAddressSats },
                invoice.bchAmount, match),
              providerLabel('haskoin'),
            );
            surfaced = true;
          }
        } catch { /* re-baseline regardless */ }
        baselineRef.current = { provider: 'blockchair', snapshot: parsed, newestTxid: null };
        if (!surfaced) publish({ state: 'waiting' }, source);
        return;
      }
      let result = evaluatePayment(base.snapshot, parsed, invoice.bchAmount, null);
      if (result.txid && result.state !== 'waiting') {
        // Ask Blockchair whether the candidate tx is still in the mempool.
        try {
          const txObj = await fetchBlockchairCandidateTx(result.txid);
          if (txObj) result = evaluatePayment(base.snapshot, parsed, invoice.bchAmount, txObj);
        } catch { /* keep the received-total based result */ }
      }
      publish(result, source);
    }

    async function handleHaskoin(hk) {
      const source = providerLabel('haskoin');
      const base = baselineRef.current;
      if (!base) {
        const newestTxid = await fetchHaskoinNewestTxid();
        baselineRef.current = { provider: 'haskoin', snapshot: hk, newestTxid };
        publish({ state: 'waiting' }, source);
        return;
      }
      if (base.provider === 'haskoin') {
        let match = null;
        if (hk.receivedSats - base.snapshot.receivedSats > 0) {
          try { match = await fetchHaskoinMatch(base.newestTxid); } catch { match = null; }
        }
        publish(evaluateHaskoinPayment(base.snapshot, hk, invoice.bchAmount, match), source);
        return;
      }
      // Provider switch: Blockchair baselined us, now it is failing and
      // Haskoin answered. Surface any payment via the tx search first, then
      // re-baseline on Haskoin so later cycles compare like-for-like.
      let surfaced = false;
      try {
        const match = await fetchHaskoinMatch(null);
        if (match) {
          publish(
            evaluateHaskoinPayment(base.snapshot,
              { ...base.snapshot, receivedSats: base.snapshot.receivedSats + match.toAddressSats },
              invoice.bchAmount, match),
            source,
          );
          surfaced = true;
        }
      } catch { /* fall through to the cross-provider delta check */ }
      if (!surfaced) {
        if (hk.receivedSats - base.snapshot.receivedSats >= minAcceptSats && minAcceptSats > 0) {
          // Cross-provider evidence without a txid: 'seen', never 'paid'.
          publish({ state: 'seen', via: 'received total increased by the invoice amount (cross-provider check; confirmation pending)' }, source);
        } else {
          publish({ state: 'waiting' }, source);
        }
      }
      baselineRef.current = { provider: 'haskoin', snapshot: hk, newestTxid: await fetchHaskoinNewestTxid() };
    }

    async function poll() {
      let sawProvider = false;
      // 1) Blockchair first, every cycle.
      let bcOutcome = { ok: false };
      try {
        const parsed = await fetchBlockchairSnapshot();
        bcOutcome = { ok: true };
        sawProvider = true;
        await handleBlockchair(parsed);
      } catch { bcOutcome = { ok: false }; }
      // 2) Haskoin fallback in the SAME cycle on any Blockchair failure.
      if (shouldUseHaskoinFallback(bcOutcome)) {
        try {
          const hk = await fetchHaskoinBalance();
          sawProvider = true;
          await handleHaskoin(hk);
        } catch { /* both providers failed this cycle */ }
      }
      if (dead) return;
      if (!sawProvider) {
        setSnap((s) => ({ ...s, note: 'Explorer check temporarily unavailable (Blockchair and the Haskoin fallback both unreachable) — retrying automatically.' }));
        timer = setTimeout(poll, 30000);
        return;
      }
      timer = setTimeout(poll, 20000);
    }
    poll();
    return () => { dead = true; clearTimeout(timer); };
  }, [invoice]);
  return snap;
}

function PayPage({ invoice }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const snap = usePaymentWatcher(invoice);
  const uri = useMemo(() => buildBip21Uri(invoice), [invoice]);
  const payLink = `${window.location.origin}${window.location.pathname}#/pay/${encodeInvoice(invoice)}`;

  useEffect(() => {
    QRCode.toDataURL(uri, { width: 520, margin: 1 }).then(setQr).catch(() => setQr(''));
  }, [uri]);

  const rateLine = invoice.rate?.source === 'manual'
    ? 'BCH amount was entered manually by the payee.'
    : invoice.rate?.bchUsd
      ? `Rate locked at creation: 1 BCH = $${invoice.rate.bchUsd.toLocaleString()}${invoice.rate.fx?.[invoice.currency] && invoice.currency !== 'USD' ? ` · 1 USD = ${invoice.rate.fx[invoice.currency].toLocaleString()} ${invoice.currency}` : ''} · ${new Date(invoice.rate.at).toLocaleString()}`
      : '';

  return (
    <section className="section pay">
      <a className="backlink" href="#/">← BlazePay home</a>
      <h2 className="section-title">{invoice.name ? `Pay ${invoice.name}` : 'Payment request'}</h2>
      {invoice.desc && <p className="section-sub">{invoice.desc}</p>}
      <div className="pay-grid">
        <div className="pay-card">
          <p className="pay-amount">{fmtFiat(invoice.amount, invoice.currency)}</p>
          <p className="pay-bch">≈ <strong>{formatBchAmount(invoice.bchAmount)} BCH</strong></p>
          {rateLine && <p className="pay-rate">{rateLine}</p>}
          <p className="pay-addr">{withPrefix(invoice.address)}</p>
          <div className="pay-actions">
            <a className="btn btn-black" href={uri}>Open in wallet</a>
            <button className="btn btn-white" onClick={() => { navigator.clipboard?.writeText(payLink); setCopied(true); }}>
              {copied ? 'Link copied ✓' : 'Copy payment link'}
            </button>
          </div>
          <p className="pay-hint">Scan the QR with any BCH wallet — Paytaca, Selene, Cashonize, Bitcoin.com — or tap “Open in wallet”.</p>
        </div>
        <div className="qr-card">
          {qr ? <img src={qr} alt="BCH payment QR code" /> : <p>Generating QR…</p>}
        </div>
      </div>

      <div className={`status-panel status-${snap.phase}`}>
        {snap.phase === 'waiting' && <><span className="dot dot-amber pulse" /> <strong>Waiting for payment…</strong></>}
        {snap.phase === 'seen' && <><span className="dot dot-amber" /> <strong>Payment seen on the network</strong> — confirming…</>}
        {snap.phase === 'paid' && <><span className="dot dot-green" /> <strong>Paid ✅</strong></>}
        {snap.note && <p>{snap.note}</p>}
        {snap.via && <p>Detected: {snap.via}.</p>}
        {snap.source && <p className="status-source">Status verified via {snap.source}.</p>}
        {snap.txid && (
          <p>Transaction: <a href={`https://blockchair.com/bitcoin-cash/transaction/${snap.txid}`} target="_blank" rel="noreferrer">{snap.txid.slice(0, 18)}…</a></p>
        )}
        {snap.phase === 'paid' && (
          <a className="btn btn-white" target="_blank" rel="noreferrer"
             href={`https://x.com/intent/post?text=${encodeURIComponent(`Just got paid in Bitcoin Cash via BlazePay ⚡ ${formatBchAmount(invoice.bchAmount)} BCH — priced in ${invoice.currency}, settled on mainnet. #BCH #BCHBLAZE`)}`}>
            Share receipt on X
          </a>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ home
function Home({ prices, onCreated }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="tags">
            <span className="tag">Payment links</span>
            <span className="tag">Bitcoin Cash</span>
            <span className="tag">No sign-up</span>
            <span className="tag">Any currency</span>
          </div>
          <h1>Get paid in BCH,<br />priced in <em>any currency</em>.</h1>
          <p className="sub">
            Make a payment link in USD, EUR, GBP, NGN, GHS, KES and more. Share it anywhere.
            Your payer scans, pays in Bitcoin Cash, and the money lands straight in your wallet —
            BlazePay never holds it.
          </p>
          <div className="cta-row">
            <a className="btn btn-black btn-big" href="#create">Create a payment link</a>
            <a className="btn btn-white btn-big" href="#how"><span className="dot dot-green" /> See how it works</a>
          </div>
        </div>
        <div className="blob-wrap"><img className="bch-logo" src={bchLogo} alt="Bitcoin Cash logo" /></div>
      </section>

      <section className="section" id="how">
        <h2 className="section-title">How it works</h2>
        <div className="steps">
          <div className="step"><span className="step-num">1</span><h3>Price it your way</h3><p>Type an amount in your own currency, connect your BCH wallet or paste your address, and BlazePay converts at the live rate and locks it into the link.</p></div>
          <div className="step"><span className="step-num">2</span><h3>Share the link</h3><p>Send it on WhatsApp, X, email — anywhere. The payer scans the QR with any BCH wallet and pays in one tap.</p></div>
          <div className="step"><span className="step-num">3</span><h3>Watch it land</h3><p>BlazePay watches the blockchain live. The moment the payment arrives, the page flips to Paid — with a receipt anyone can verify.</p></div>
        </div>
      </section>

      <CreateForm prices={prices} onCreated={onCreated} />
    </>
  );
}

// ------------------------------------------------------------------ app
export default function App() {
  const prices = usePrices();
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const payMatch = hash.match(/^#\/pay\/(.+)$/);
  let payInvoice = null; let payError = null;
  if (payMatch) {
    try { payInvoice = decodeInvoice(payMatch[1]); } catch { payError = 'That payment link looks broken or incomplete.'; }
  }

  return (
    <div className="page">
      <div className="card">
        <HackathonBanner />
        <TopBar />
        <main>
          {payMatch ? (
            payInvoice ? <PayPage invoice={payInvoice} /> : (
              <section className="section"><h2 className="section-title">Hmm, broken link</h2><p className="section-sub">{payError} Ask the payee to share their BlazePay link again.</p></section>
            )
          ) : (
            <Home prices={prices} onCreated={(inv) => { window.location.hash = `#/pay/${encodeInvoice(inv)}`; }} />
          )}
        </main>
        <footer className="footer">
          <span className="wordmark small">BlazePay<sup>®</sup></span>
          <p>Non-custodial payment links for Bitcoin Cash, priced in any currency. BlazePay never holds your money — payments go wallet-to-wallet on BCH mainnet.</p>
          <p className="footer-fine">Built for BCH BLAZE 2026 · Wallet connect by WizardConnect · The mainnet end-to-end test is still to come.</p>
        </footer>
      </div>
    </div>
  );
}
