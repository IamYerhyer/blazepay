# BlazePay — Get paid in BCH, priced in any currency

BlazePay is a **global, multi-currency** payment-link tool for Bitcoin Cash,
built for the **BCH BLAZE 2026** hackathon (DoraHacks, submissions close
22 Nov 2026, 15:00 WAT).

**How it works:** create a payment link priced in your own currency — USD, EUR,
GBP, NGN, GHS, KES and more — share it anywhere, and your payer settles in BCH
on mainnet with one scan. BlazePay converts at the live rate, locks that rate
into the link, and watches the blockchain until the payment lands, then shows a
verifiable Paid receipt. No sign-up, no backend, no custody: payments go
wallet-to-wallet, and the invoice itself travels inside the shareable link
(base64url-encoded JSON in the URL hash).

The UI follows the design language of the Framer Marketplace "Conversion"
template chosen by Yahya (warm off-white page, white rounded card, serif
wordmark + italic serif accents, pill buttons/tags, one large gradient blob —
recoloured to BCH green → flame). Structure and feel only; all copy is ours.

## Run it

```bash
npm install
npm run dev      # local dev server
npm test         # logic tests (node --test)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## How the pieces work

- **Create** (`src/App.jsx` → `CreateForm`): payee name, description, amount +
  currency (USD default; USD, EUR, GBP, NGN, GHS, KES), BCH CashAddr with a
  *light* format validation (prefix/length/charset — not a full checksum
  verification, and the UI says so), optional manual BCH amount override.
- **Rates**: BCH/USD from the CoinGecko public API; FX from
  `open.er-api.com/v6/latest/USD` (rates quoted per USD, so any currency
  converts via its USD cross rate). The rate used and its timestamp are
  snapshotted onto the invoice and shown on the pay page. If rates fail, the UI
  says so and the manual BCH amount becomes the path forward.
- **Pay page** (`#/pay/<payload>`): invoice summary, BIP21 URI
  (`bitcoincash:<addr>?amount=…&label=…&message=…`) rendered as a QR via the
  `qrcode` package, an "Open in wallet" link, and a copy-link button.
- **Payment watching (v2 — dual provider)**: polls every ~20s, **Blockchair
  first, Haskoin as fallback in the same cycle**. First successful snapshot is
  the baseline; a later increase in the address's lifetime `received` total of
  ≥ 99.5% of the invoice amount marks the payment — **Seen (mempool)** while
  unconfirmed, **Paid (confirmed)** once confirmed — with the paying txid and
  a Blockchair explorer link as the receipt.
  - *Blockchair path*: `GET /bitcoin-cash/dashboards/address/<bare-address>`;
    a new txid plus the received-delta marks the payment, and the candidate tx
    is checked via `dashboards/transaction/<txid>`: `block_id = -1` → Seen,
    otherwise Paid.
  - *Haskoin fallback path*: any Blockchair failure (network error, non-200,
    HTTP 430, malformed body) routes the same cycle to
    `api.haskoin.com/bch/address/<bare>/balance` (satoshi integers:
    `received`, `confirmed`, `unconfirmed`). The paying tx is found via
    `/transactions/full?limit=25` — newest first, an output to the invoice
    address ≥ 99.5% of the amount — and classified by its block marker
    (`block: { height, … }` → Paid; `block: null` → Seen). Without a found tx,
    the unconfirmed-balance movement decides, and ambiguous data is reported
    as Seen, never Paid.
  - *Provider consistency*: a baseline is only ever compared against
    snapshots from the **same** provider. If the provider switches mid-watch,
    the watcher first surfaces any already-landed payment via the Haskoin tx
    search (filtered to the invoice's lifetime / the baseline's newest txid),
    then re-baselines on the new provider; detected states are latched, so a
    switch can never lose or downgrade a payment.
  - The status panel names its source in small text — *"Status verified via
    Blockchair"* or *"Status verified via Haskoin fallback"* — and if **both**
    providers are unreachable in a cycle it says so and retries; it never
    fakes a payment state.
  - Pure logic lives in `src/lib/blaze.js` (`evaluatePayment`,
    `parseAddressDashboard`, `evaluateHaskoinPayment`, `parseHaskoinBalance`,
    `parseHaskoinTransaction`, `findHaskoinPaymentTx`,
    `shouldUseHaskoinFallback`) and is unit-tested.
- **Pure logic** (`src/lib/blaze.js`): CashAddr light validation, fiat→BCH
  conversion, BIP21 building, invoice encode/decode, payment evaluation for
  both watcher providers. Tests in `tests/blaze.test.mjs` (13 tests).

## Current status — SCAFFOLD (14 Nov 2026)

Working locally: home/hero, create form with live multi-currency conversion,
shareable pay links, QR, dual-provider payment watcher (Blockchair primary +
Haskoin fallback), receipt state, tests, production build. **Nothing is
deployed, there is no GitHub repo yet, and no real wallet or funds have been
used** (watcher verification used read-only public data only).

### Why the watcher has two providers (verified 14 Nov 2026)

Blockchair's free API **rate-limits shared IPs hard**: from this build
machine's egress IP, `dashboards/address/…` consistently returns HTTP 430
("IP temporary blacklisted due to exceeding usage"). That is exactly why the
**Haskoin fallback** exists — a payment page opened from such an IP would
otherwise never see a payment. Haskoin was verified live from the same
machine tonight: `/balance` and `/transactions/full` answer 200 with
`Access-Control-Allow-Origin: *`, and the new parsers were smoke-tested
against real mainnet data (balance + a real incoming tx classified Paid with
its block height). Both providers are keyless and CORS-enabled. Two honest
limits remain: Blockchair's mempool branch (`block_id = -1`) still could not
be exercised from this IP (430), so that path is coded defensively against
Blockchair's documented shape; and no live Haskoin *mempool* sample was
captured tonight, so its `block: null` handling is likewise defensive. If
both providers fail in the same cycle, the watcher shows "temporarily
unavailable — retrying" and backs off to 30s; it never invents a state.

## Honest TODO list

- [ ] **WizardConnect integration** — the "Connect wallet" button is currently
      an honestly-labelled placeholder ("coming in the next step"); manual
      CashAddr paste is the working path. Integrate `@wizardconnect/react` /
      `dapp` / `core` so a Paytaca/Cashonize wallet pre-fills the payee address.
- [ ] **EMBER2026 banner address** — the top banner shows a clearly-marked TODO
      placeholder. Needs Yahya's real CashTokens (token-aware, `bitcoincash:z…`)
      address from his own wallet.
- [ ] **Widget Factory presentation** — banner link is a `#` TODO placeholder;
      slides still to be made from the official template.
- [ ] **GitHub repo** — not created yet (needs Yahya's go-ahead); banner repo
      link is a `#` TODO placeholder until then.
- [ ] **Telegram confirmation** — post the "we're real" confirmation in
      t.me/bchblaze (needs Yahya's approval of the exact message).
- [ ] **Mainnet end-to-end test** — with Yahya's own BCH wallet and a tiny real
      payment (~$1–2), verifying Waiting → Seen → Paid on the live pay page.
- [x] **Watcher fallback** — Haskoin fallback implemented (see "Payment
      watching (v2)" above); a Blockchair API key is now optional hardening,
      not a requirement.
- [ ] **Pay page opened after payment** — the baseline currently starts when
      the page loads, so a payment sent before the page was opened is not
      detected; the Haskoin tx search (invoice-lifetime filter) could cover
      this case.
- [ ] **Full CashAddr checksum** (polymod) validation to replace/augment the
      light format check.
- [ ] Deploy to GitHub Pages (after repo approval) and submit the BUIDL on
      DoraHacks before 22 Nov 15:00 WAT.
