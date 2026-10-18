// Double-entry integer ledger (design doc §8.6). Every transaction's postings balance per currency,
// spendable and escrow accounts never go negative, idempotency keys prevent duplicate effects, and
// corrections are new compensating transactions rather than edits.

import type { LedgerAccount, LedgerState, LedgerTx } from './types.ts';

export type PostResult = { ok: true; tx: LedgerTx } | { ok: false; err: string };

const TX_KEEP = 2500;
const IDEM_KEEP = 8000;

export class Ledger {
  st: LedgerState;
  private idemSet: Set<string>;

  constructor(st?: LedgerState) {
    this.st = st ?? {
      accounts: [], balances: [], txs: [], idem: [], nextTx: 1,
      totals: { minted: 0, paid: 0, refunded: 0, retired: 0, meritMinted: 0, meritSpent: 0 },
    };
    this.idemSet = new Set(this.st.idem);
  }

  open(owner: string, currency: LedgerAccount['currency'], kind: LedgerAccount['kind']): number {
    const id = this.st.accounts.length;
    this.st.accounts.push({ id, owner, currency, kind });
    this.st.balances.push(0);
    return id;
  }

  find(owner: string, currency: LedgerAccount['currency'], kind: LedgerAccount['kind']): number {
    const a = this.st.accounts.find((x) => x.owner === owner && x.currency === currency && x.kind === kind);
    return a ? a.id : this.open(owner, currency, kind);
  }

  balance(acct: number): number { return acct >= 0 ? this.st.balances[acct] ?? 0 : 0; }

  seen(idem: string): boolean { return this.idemSet.has(idem); }

  post(type: string, ref: string, idem: string, postings: [number, number][], tick: number): PostResult {
    if (idem && this.idemSet.has(idem)) return { ok: false, err: 'duplicate request (idempotency key already used)' };
    const sums = new Map<string, number>();
    for (const [acct, amt] of postings) {
      const a = this.st.accounts[acct];
      if (!a) return { ok: false, err: `unknown account ${acct}` };
      if (!Number.isInteger(amt)) return { ok: false, err: 'non-integer amount' };
      sums.set(a.currency, (sums.get(a.currency) ?? 0) + amt);
    }
    for (const [, v] of sums) if (v !== 0) return { ok: false, err: 'postings do not balance' };
    // non-negative constraint for spendable, escrow and treasury accounts
    const next = new Map<number, number>();
    for (const [acct, amt] of postings) next.set(acct, (next.get(acct) ?? this.st.balances[acct]) + amt);
    for (const [acct, bal] of next) {
      const k = this.st.accounts[acct].kind;
      if (bal < 0 && k !== 'issuance') return { ok: false, err: 'insufficient balance' };
    }
    for (const [acct, bal] of next) this.st.balances[acct] = bal;
    const tx: LedgerTx = { id: this.st.nextTx++, type, ref, idem, tick, postings };
    this.st.txs.push(tx);
    if (this.st.txs.length > TX_KEEP) this.st.txs.splice(0, this.st.txs.length - TX_KEEP);
    if (idem) {
      this.idemSet.add(idem);
      this.st.idem.push(idem);
      if (this.st.idem.length > IDEM_KEEP) {
        const drop = this.st.idem.splice(0, this.st.idem.length - IDEM_KEEP);
        for (const d of drop) this.idemSet.delete(d);
      }
    }
    const t = this.st.totals;
    const positive = postings.filter(([a, v]) => v > 0 && this.st.accounts[a].kind !== 'escrow' && this.st.accounts[a].kind !== 'sink').reduce((s, [, v]) => s + v, 0);
    switch (type) {
      case 'grant': t.minted += positive; break;
      case 'payout': t.paid += positive; break;
      case 'refund': t.refunded += positive; break;
      case 'cosmetic': t.retired += postings.filter(([a, v]) => v > 0 && this.st.accounts[a].kind === 'sink').reduce((s, [, v]) => s + v, 0); break;
      case 'merit_mint': t.meritMinted += positive; break;
      case 'merit_spend': t.meritSpent += postings.filter(([a, v]) => v > 0 && this.st.accounts[a].kind === 'sink').reduce((s, [, v]) => s + v, 0); break;
    }
    return { ok: true, tx };
  }

  /** Global invariant: balances sum to zero per currency (issuance accounts carry the negative). */
  balanced(): boolean {
    const sums = new Map<string, number>();
    this.st.accounts.forEach((a, i) => sums.set(a.currency, (sums.get(a.currency) ?? 0) + this.st.balances[i]));
    for (const [, v] of sums) if (v !== 0) return false;
    return true;
  }

  totalOf(kind: LedgerAccount['kind'], currency: LedgerAccount['currency']): number {
    let s = 0;
    this.st.accounts.forEach((a, i) => { if (a.kind === kind && a.currency === currency) s += this.st.balances[i]; });
    return s;
  }
}
