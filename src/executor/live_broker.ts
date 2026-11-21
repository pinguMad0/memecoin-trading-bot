// Builds Jupiter swaps and submits them through Jito or plain RPC.
// Buying and selling stay blocked unless live mode was explicitly enabled.
import { Connection, Keypair, Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import base64 from 'base64-js';
import { JUPITER_API_BASE, JITO_BLOCK_ENGINE, JITO_TIP_ACCOUNTS_URL, SOL_MINT } from './config';

export interface QuoteResult {
    quote: any;
    inAmountLamports: number;
    outAmountRaw: string;
    priceImpactPct: number;
}

export class LiveBroker {
    private keypair: Keypair | null = null;
    private connection: Connection | null = null;
    private tipAccounts: string[] | null = null;
    private tipAccountsAt = 0;
    public lastError: string | null = null;

    constructor(private enabled: boolean, privateKeyBase58: string | null, rpcUrl: string | null) {
        // RPC connection is read-only plumbing: needed for the fill probe
        // (mint decimals) in paper mode too. Only the KEYPAIR is gated.
        if (rpcUrl) {
            this.connection = new Connection(rpcUrl, 'confirmed');
        }
        if (this.enabled && privateKeyBase58 && rpcUrl) {
            try {
                const bs58mod = require('bs58');
                const bs58 = bs58mod.default || bs58mod;
                this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
            } catch (e: any) {
                this.enabled = false;
                this.lastError = `wallet init failed: ${e.message}`;
            }
        } else if (this.enabled) {
            this.enabled = false;
            this.lastError = 'live broker enabled without key/rpc';
        }
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    get walletPubkey(): string | null {
        return this.keypair ? this.keypair.publicKey.toBase58() : null;
    }

    // Wallet SOL balance (confirmed commitment).
    async getWalletBalance(): Promise<number> {
        const bal = await this.connection!.getBalance(this.keypair!.publicKey, 'confirmed');
        return bal / 1e9;
    }

    // Raw token balance (unminted base units) for the wallet + mint.
    private decimalsCache = new Map<string, number | null>();
    private solUsdCache: { usd: number | null; at: number } = { usd: null, at: 0 };

    async getMintDecimals(mint: string): Promise<number | null> {
        if (!this.connection) return null;
        if (this.decimalsCache.has(mint)) return this.decimalsCache.get(mint) ?? null;
        try {
            const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
            const dec = (info.value?.data as any)?.parsed?.info?.decimals ?? null;
            this.decimalsCache.set(mint, dec);
            return dec;
        } catch {
            this.decimalsCache.set(mint, null);
            return null;
        }
    }

    // SOL/USD via a small SOL->USDC quote, cached for 60 seconds.
    async getSolUsd(): Promise<number | null> {
        const now = Date.now();
        if (this.solUsdCache.usd !== null && now - this.solUsdCache.at < 60_000) {
            return this.solUsdCache.usd;
        }
        const STAKE = 0.1;
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        try {
            const q = await this.quoteBuy(USDC, STAKE, 300);
            if (q) {
                const usdReceived = Number(q.outAmountRaw) / 1e6;
                const usd = usdReceived / STAKE;
                this.solUsdCache = { usd, at: now };
                return usd;
            }
        } catch { /* fall through */ }
        return this.solUsdCache.usd;
    }

    async getTokenBalance(mint: string): Promise<number | null> {
        if (!this.enabled || !this.connection || !this.keypair) return null;
        try {
            const res = await this.connection.getParsedTokenAccountsByOwner(
                this.keypair.publicKey,
                { mint: new PublicKey(mint) }
            );
            let total = 0;
            for (const { account } of res.value) {
                const amt = (account.data as any)?.parsed?.info?.tokenAmount?.amount;
                if (amt) total += Number(amt);
            }
            return total;
        } catch (e: any) {
            this.lastError = `balance fetch failed: ${e.message}`;
            return null;
        }
    }

    // Read-only quote (works even when live is off, for --selftest reachability).
    async quoteBuy(mint: string, amountSol: number, slippageBps: number): Promise<QuoteResult | null> {
        try {
            const lamports = Math.floor(amountSol * 1e9);
            const url = `${JUPITER_API_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}` +
                `&amount=${lamports}&slippageBps=${slippageBps}`;
            const quote = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
            if (!quote || quote.error) {
                this.lastError = quote ? quote.error : 'empty quote';
                return null;
            }
            return {
                quote,
                inAmountLamports: lamports,
                outAmountRaw: quote.outAmount,
                priceImpactPct: Number(quote.priceImpactPct || 0),
            };
        } catch (e: any) {
            this.lastError = `quote failed: ${e.message}`;
            return null;
        }
    }

    async quoteSell(mint: string, tokenRawAmount: string, slippageBps: number): Promise<any | null> {
        try {
            const url = `${JUPITER_API_BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}` +
                `&amount=${tokenRawAmount}&slippageBps=${slippageBps}`;
            const quote = await (await fetch(url, { headers: { Accept: 'application/json' } })).json();
            return quote && !quote.error ? quote : null;
        } catch (e: any) {
            this.lastError = `sell quote failed: ${e.message}`;
            return null;
        }
    }

    // Build + sign + submit a buy. Returns signature on success.
    async buy(mint: string, amountSol: number, slippageBps: number, jitoTipLamports: number): Promise<string | null> {
        if (!this.enabled || !this.keypair) {
            this.lastError = 'buy blocked: live gate is closed';
            return null;
        }
        const q = await this.quoteBuy(mint, amountSol, slippageBps);
        if (!q) return null;
        return this.buildAndSend(q.quote, jitoTipLamports);
    }

    async sell(mint: string, tokenRawAmount: string, slippageBps: number, jitoTipLamports: number): Promise<string | null> {
        if (!this.enabled || !this.keypair) {
            this.lastError = 'sell blocked: live gate is closed';
            return null;
        }
        const quote = await this.quoteSell(mint, tokenRawAmount, slippageBps);
        if (!quote) return null;
        return this.buildAndSend(quote, jitoTipLamports);
    }

    // Both Transaction and VersionedTransaction instances expose serialize().
    private serializeTx(tx: Transaction | VersionedTransaction): Buffer {
        return Buffer.from(tx.serialize() as Uint8Array);
    }

    // A submitted signature only counts once it confirms on-chain.
    private async confirmLanded(sig: string, timeoutMs = 75_000): Promise<boolean> {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            try {
                const res = await this.connection!.getSignatureStatuses([sig], {
                    searchTransactionHistory: true,
                });
                const st = res.value && res.value[0];
                if (st) {
                    if (st.err) {
                        this.lastError = `tx failed on-chain: ${JSON.stringify(st.err).slice(0, 200)}`;
                        return false;
                    }
                    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
                        return true;
                    }
                }
            } catch { /* transient RPC error — keep polling */ }
            await new Promise((r) => setTimeout(r, 3000));
        }
        this.lastError = 'tx dropped: not seen on-chain within the blockhash window';
        return false;
    }

    // Landing engine: Jito bundle with tip escalation (tips are paid ONLY
    // when the bundle lands, so escalation attempts are free), then plain-RPC
    // confirmation as the fallback. No more mempool lottery.
    private async submitWithLanding(tx: Transaction | VersionedTransaction): Promise<string | null> {
        const TIP_LADDER = [100_000, 500_000, 2_000_000];
        const swapSig = this.extractSignature(tx);
        for (const tip of TIP_LADDER) {
            const bundleId = await this.sendJitoBundle(tx, tip);
            if (bundleId) {
                const landed = await this.confirmBundleLanded(bundleId);
                if (landed) {
                    this.consoleSafe(`bundle landed (tip ${tip}, id ${bundleId.slice(0, 12)}…)`);
                    return swapSig;
                }
                this.consoleSafe(`bundle ${bundleId.slice(0, 12)}… did not land at tip ${tip} (cost: 0)`);
            }
        }
        // Fallback: plain RPC with confirmation (works when the block engine is unreachable)
        this.consoleSafe('Jito path exhausted — plain RPC fallback (preflight on: failed sims are free, no fee burn)');
        try {
            const sig = await this.connection!.sendRawTransaction(
                this.serializeTx(tx),
                { skipPreflight: false, maxRetries: 5 } // preflight: slippage-type
                // failures get caught in simulation — no on-chain fee burn
            );
            const landed = await this.confirmLanded(sig);
            if (landed) return sig;
            return null;
        } catch (e: any) {
            this.lastError = `fallback send failed: ${e.message}`;
            return null;
        }
    }

    private extractSignature(tx: Transaction | VersionedTransaction): string {
        const bs58mod = require('bs58');
        const b58 = bs58mod.default || bs58mod;
        try {
            const raw = (tx instanceof VersionedTransaction
                ? tx.signatures![0]
                : tx.signatures[0]) as unknown as Uint8Array;
            return b58.encode(raw);
        } catch {
            return 'unknown-sig';
        }
    }

    private async sendJitoBundle(tx: Transaction | VersionedTransaction, tipLamports: number): Promise<string | null> {
        try {
            const tips = await this.getTipAccounts();
            if (!tips.length) return null;
            const tip = new Transaction().add(
                (require('@solana/web3.js').SystemProgram as any).transfer({
                    fromPubkey: this.keypair!.publicKey,
                    toPubkey: new PublicKey(tips[Math.floor(Math.random() * tips.length)]),
                    lamports: tipLamports,
                })
            );
            const { blockhash } = await this.connection!.getLatestBlockhash();
            tip.recentBlockhash = blockhash;
            tip.feePayer = this.keypair!.publicKey;
            tip.sign(this.keypair!);
            const encoded = this.serializeTx(tx).toString('base64');
            const resp = await (await fetch(JITO_BLOCK_ENGINE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'sendBundle',
                    params: [[encoded, tip.serialize().toString('base64')]],
                }),
            })).json();
            if (resp.error || !resp.result) {
                this.lastError = `jito sendBundle: ${JSON.stringify(resp.error || 'no result').slice(0, 120)}`;
                return null;
            }
            return resp.result as string;
        } catch (e: any) {
            this.lastError = `jito send failed: ${e.message}`;
            return null;
        }
    }

    // Poll the block engine until the bundle lands or the window expires.
    // Unlanded bundles cost nothing (tips only execute on landing).
    private async confirmBundleLanded(bundleId: string, timeoutMs = 15_000): Promise<boolean> {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            try {
                const resp = await (await fetch(JITO_BLOCK_ENGINE, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0', id: 1, method: 'getBundleStatuses',
                        params: [[bundleId]],
                        format: 'json',
                    }),
                })).json();
                const st = resp?.result?.value?.[0];
                if (st) {
                    const cs = st.confirmation_status;
                    if (cs === 'processed' || cs === 'confirmed' || cs === 'finalized') return true;
                    if (st.err) {
                        this.lastError = `bundle error: ${JSON.stringify(st.err).slice(0, 120)}`;
                        return false;
                    }
                }
            } catch { /* transient — keep polling */ }
            await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
    }

    private async buildAndSend(quote: any, _jitoTipLamports: number): Promise<string | null> {
        try {
            const swapResp = await (await fetch(`${JUPITER_API_BASE}/swap`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.keypair!.publicKey.toBase58(),
                    wrapAndUnwrapSol: true,
                    prioritizationFeeLamports: 100_000,
                }),
            })).json();
            if (!swapResp || !swapResp.swapTransaction) {
                this.lastError = swapResp?.error || 'no swapTransaction in response';
                return null;
            }
            const raw = Buffer.from(base64.toByteArray(swapResp.swapTransaction));
            let tx: Transaction | VersionedTransaction;
            try {
                tx = VersionedTransaction.deserialize(raw);
                tx.sign([this.keypair!]);
            } catch {
                tx = Transaction.from(raw);
                tx.partialSign(this.keypair!);
            }
            return await this.submitWithLanding(tx);
        } catch (e: any) {
            this.lastError = `build/send failed: ${e.message}`;
            return null;
        }
    }

    // stderr logging that survives the ts-node stdout quirks.
    private consoleSafe(line: string): void {
        console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    }

    private async getTipAccounts(): Promise<string[]> {
        const now = Date.now();
        if (this.tipAccounts && now - this.tipAccountsAt < 30_000) return this.tipAccounts;
        try {
            const list = await (await fetch(JITO_TIP_ACCOUNTS_URL)).json();
            this.tipAccounts = Array.isArray(list) ? list : [];
            this.tipAccountsAt = now;
        } catch {
            this.tipAccounts = this.tipAccounts || [];
            this.tipAccountsAt = now;
        }
        return this.tipAccounts;
    }

}
