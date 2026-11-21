// Direct pump.fun bonding-curve broker. Prices use the constant-product
// reserves, and account templates come from recent successful curve trades.
// Missing or inconsistent templates fail closed. SOL goes directly to the
// curve, so this path does not need WSOL wrapping.
import {
    ComputeBudgetProgram, Connection, Keypair, PublicKey,
    Transaction, TransactionInstruction,
} from '@solana/web3.js';
import * as path from 'path';
import { SIGNALS_DIR } from './config';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PFEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const FEE_CONFIG = new PublicKey('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROG = new PublicKey('ATokenGPvbdgxrpVzKhtMpwXtMVLs7HSKdJD3nd7STXo');

const CURVE_DISC = Buffer.from('17b7f83760d8ac60', 'hex');
const DISC_BUY = Buffer.from('66063d1201daebea', 'hex');
const DISC_SELL = Buffer.from('33e685a4017f83ad', 'hex');
const K_STD = 3.219e25; // vTok*vSol of a standard-parameter curve (theory doc)
const FEE_BPS = 200n;   // conservative budget vs measured 0-173 bps spread

interface CurveStateLive {
    curve: PublicKey;
    mint: PublicKey;
    vTok: bigint;
    vSol: bigint;
    rTok: bigint;
    rSol: bigint;
    supply: bigint;
    complete: boolean;
    userAta: PublicKey | null;
    userAtaExists: boolean;
}

interface Template {
    buy: { fee1: string; acct9: string; acct12: string; acct13: string; acct16: string; acct17: string } | null;
    sell: { fee2: string; acct14: string; acct15: string } | null;
    at: number;
    // observed instruction generation(s) on live buys of this curve:
    // '66063d1201daebea' (legacy global:buy) or '8b8dd6794046280e' (2026 gen)
    disc?: string;
    buysSampled?: number;
}

function pda(seeds: (Buffer | Uint8Array)[], prog: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, prog)[0];
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
    return pda([owner.toBuffer(), TOKEN22.toBuffer(), mint.toBuffer()], ATA_PROG);
}

function u64le(v: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
}

export class CurveBroker {
    private keypair: Keypair | null = null;
    private connection: Connection | null = null;
    public lastError: string | null = null;
    private enabled: boolean;
    private decimalsCache = new Map<string, number | null>();
    private solUsdCache: { usd: number | null; at: number } = { usd: null, at: 0 };
    private templates = new Map<string, Template>();
    private feeMicro: number | null = null;

    constructor(enabled: boolean, privateKeyBase58: string | null, rpcUrl: string | null) {
        this.enabled = enabled;
        if (rpcUrl) this.connection = new Connection(rpcUrl, 'confirmed');
        if (enabled && privateKeyBase58 && rpcUrl) {
            try {
                const bs58mod = require('bs58');
                const bs58 = bs58mod.default || bs58mod;
                this.keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
            } catch (e: any) {
                this.enabled = false;
                this.lastError = `wallet init failed: ${e.message}`;
            }
        } else if (enabled) {
            this.enabled = false;
            this.lastError = 'live broker enabled without key/rpc';
        }
        if (this.connection) {
            this.refreshFeeOracle();
            const timer = setInterval(() => this.refreshFeeOracle(), 30_000);
            if (typeof timer.unref === 'function') timer.unref();
        }
    }

    get isEnabled(): boolean { return this.enabled; }
    get walletPubkey(): string | null { return this.keypair ? this.keypair.publicKey.toBase58() : null; }

    private async refreshFeeOracle(): Promise<void> {
        if (!this.connection) return;
        try {
            const globalAcct = pda([Buffer.from('global')], PUMP).toBase58();
            const resp = await (this.connection as any)._rpcRequest('getPriorityFeeEstimate', [{
                accountKeys: [globalAcct],
                options: { priorityLevel: process.env.CURVE_FEE_LEVEL || 'High',
                    lookbackSlots: 150, includeVote: false, evaluateEmptySlotAsZero: true },
            }]);
            const est = resp?.result?.priorityFeeEstimate;
            if (typeof est === 'number' && est >= 0) {
                const mult = Number(process.env.CURVE_FEE_MULT || 1);
                const cap = Number(process.env.CURVE_PRIORITY_MICROLAMPORTS_MAX || 700_000);
                this.feeMicro = Math.max(1, Math.min(Math.ceil(est * mult), cap));
            }
        } catch { /* keep last-known estimate */ }
    }

    async getWalletBalance(): Promise<number> {
        const bal = await this.connection!.getBalance(this.keypair!.publicKey, 'confirmed');
        return bal / 1e9;
    }

    async getMintDecimals(mint: string): Promise<number | null> {
        if (this.decimalsCache.has(mint)) return this.decimalsCache.get(mint)!;
        const info = await this.connection!.getParsedAccountInfo(new PublicKey(mint));
        const dec = (info.value?.data as any)?.parsed?.info?.decimals ?? null;
        this.decimalsCache.set(mint, dec);
        return dec;
    }

    async getSolUsd(): Promise<number | null> {
        const now = Date.now();
        if (this.solUsdCache.usd && now - this.solUsdCache.at < 300_000) return this.solUsdCache.usd;
        try {
            const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const j = await r.json();
            if (j?.solana?.usd) {
                this.solUsdCache = { usd: Number(j.solana.usd), at: now };
                return this.solUsdCache.usd;
            }
        } catch { /* fall through */ }
        return this.solUsdCache.usd; // stale fallback, never fabricated
    }

    async getTokenBalance(mint: string): Promise<number | null> {
        if (!this.keypair) return null;
        try {
            const a = ata(new PublicKey(mint), this.keypair.publicKey);
            const info = await this.connection!.getParsedAccountInfo(a);
            const amt = (info.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? null;
            if (amt === null) return 0;
            return Number(amt) * Math.pow(10, (await this.getMintDecimals(mint)) || 6);
        } catch (e: any) {
            this.lastError = `balance read failed: ${e.message}`;
            return null;
        }
    }

    // Curve account decode per CURVE_WIRE_FORMAT.md (166B layout).
    async fetchCurveState(mintS: string): Promise<CurveStateLive | null> {
        try {
            const mint = new PublicKey(mintS);
            const curve = pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
            const info = await this.connection!.getAccountInfo(curve);
            if (!info) { this.lastError = 'curve account missing (graduated or non-curve token)'; return null; }
            const d = Buffer.from(info.data);
            if (d.length !== 166 || !d.subarray(0, 8).equals(CURVE_DISC)) {
                this.lastError = 'unexpected curve account layout';
                return null;
            }
            const vTok = BigInt(d.readBigUInt64LE(8));
            const vSol = BigInt(d.readBigUInt64LE(16));
            const rTok = BigInt(d.readBigUInt64LE(24));
            const rSol = BigInt(d.readBigUInt64LE(32));
            const supply = BigInt(d.readBigUInt64LE(40));
            const complete = d[48] === 1;
            if (complete) { this.lastError = 'curve complete (graduated)'; return null; }
            if (supply !== 1_000_000_000_000_000n) { this.lastError = 'non-standard curve (supply)'; return null; }
            const k = Number(vTok) * Number(vSol);
            if (Math.abs(k - K_STD) / K_STD > 0.05) { this.lastError = 'outlier-K curve (non-standard params)'; return null; }
            const user = this.keypair ? this.keypair.publicKey : null;
            const userAta = user ? ata(mint, user) : null;
            const ataInfo = userAta ? await this.connection!.getParsedAccountInfo(userAta) : null;
            return { curve, mint, vTok, vSol, rTok, rSol, supply, complete, userAta, userAtaExists: !!ataInfo?.value };
        } catch (e: any) {
            this.lastError = `curve state failed: ${e.message}`;
            return null;
        }
    }

    // Marginal USD/token price from virtual reserves (200 bps fee budget in
    // the denominator — a seller receives less, a buyer pays more).
    async curvePrice(mint: string): Promise<number | null> {
        const st = await this.fetchCurveState(mint);
        if (!st) return null;
        const solUsd = await this.getSolUsd();
        if (!solUsd) { this.lastError = 'sol usd unavailable'; return null; }
        const netFrac = Number(10_000n - FEE_BPS) / 10_000;
        const lamportsPerRaw = (Number(st.vSol) * netFrac) / Number(st.vTok); // lamports per raw token
        const dec = (await this.getMintDecimals(mint)) ?? 6;
        const solPerToken = (lamportsPerRaw * Math.pow(10, dec)) / 1e9;
        return solPerToken * solUsd;
    }

    // CP quote per CURVE_THEORY.md: net = solIn * (1 - fee); out = vTok - K/(vSol + net).
    async quoteBuy(mint: string, solIn: number): Promise<{ outRaw: bigint; pricePerTokenSol: number; impactPct: number } | null> {
        const st = await this.fetchCurveState(mint);
        if (!st) return null;
        const q = BigInt(Math.floor(solIn * 1e9));
        const net = (q * (10_000n - FEE_BPS)) / 10_000n;
        const out = st.vTok - (st.vTok * st.vSol) / (st.vSol + net);
        if (out <= 0n) { this.lastError = 'zero curve quote'; return null; }
        const marginal = Number(st.vSol) / Number(st.vTok);
        const effective = Number(net) / Number(out);
        return { outRaw: out, pricePerTokenSol: effective / 1e9, impactPct: 100 * (effective / marginal - 1) };
    }

    // Cache account templates on disk so restarts do not need to refetch them.
    private templatesFile = path.join(SIGNALS_DIR, 'curve_templates.json');
    private templatesDisk: Map<string, Template> | null = null;

    private loadTemplateDisk(): Map<string, Template> {
        if (!this.templatesDisk) {
            try {
                const fs = require('fs');
                this.templatesDisk = new Map(Object.entries(JSON.parse(fs.readFileSync(this.templatesFile, 'utf-8'))));
            } catch { this.templatesDisk = new Map(); }
        }
        return this.templatesDisk!;
    }

    private saveTemplateDisk(): void {
        try {
            const fs = require('fs');
            fs.writeFileSync(this.templatesFile, JSON.stringify(Object.fromEntries(this.templatesDisk!), null, 1));
        } catch { /* best-effort persistence */ }
    }

    // Resolution order: memory -> disk -> live harvest.
    private async fetchTemplate(mint: string): Promise<Template | null> {
        const mem = this.templates.get(mint);
        if (mem && Date.now() - mem.at < 600_000) return mem;
        const disk = this.loadTemplateDisk().get(mint);
        if (disk) { this.templates.set(mint, disk); return disk; }
        return await this.harvestTemplate(mint);
    }

    // Harvest + verify + persist. Consistency check = the sanity gate: the
    // per-mint slots must be IDENTICAL across >=2 observed buys of the same
    // curve, or the template is rejected (user-dependent slots 5/6 excluded).
    async harvestTemplate(mint: string): Promise<Template | null> {
        try {
            const curvePk = pda([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP);
            const rpc = (this.connection as any)._rpcEndpoint as string;
            const call = async (method: string, params: any[]) => {
                for (let attempt = 0; attempt < 4; attempt++) {
                    const r = await fetch(rpc, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
                    });
                    if (r.status === 429) { await new Promise((x) => setTimeout(x, 1500 + 2000 * attempt)); continue; }
                    return (await r.json()).result;
                }
                return null;
            };
            const sigs = await call('getSignaturesForAddress', [curvePk.toBase58(), { limit: 100 }]);
            const ok = (sigs || []).filter((s: any) => !s.err);
            const buys: { slots: { fee1: string; acct9: string; acct12: string; acct13: string; acct16: string; acct17: string }; disc: string }[] = [];
            let sell: Template['sell'] = null;
            let discSeen: string | undefined;
            for (const s of ok) {
                if (buys.length >= 3 && sell) break;
                const tx = await call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
                if (!tx?.transaction?.message?.instructions) continue;
                const keys = [...tx.transaction.message.accountKeys,
                    ...(tx.meta?.loadedAddresses?.writable || []),
                    ...(tx.meta?.loadedAddresses?.readonly || [])];
                const scan = [
                    ...tx.transaction.message.instructions,
                    ...(tx.meta?.innerInstructions || []).flatMap((inn: any) => inn.instructions || []),
                ];
                for (const ix of scan) {
                    const pid = keys[ix.programIdIndex];
                    if (pid !== PUMP.toBase58()) continue;
                    const data = Buffer.from(ix.data, 'base64');
                    const disc = data.subarray(0, 8).toString('hex');
                    const accts = (ix.accounts || []).map((i: number) => keys[i]);
                    const isBuy = disc === '66063d1201daebea' || disc === '8b8dd6794046280e';
                    if (accts.length === 18 && isBuy && buys.length < 3) {
                        buys.push({
                            slots: { fee1: accts[1], acct9: accts[9], acct12: accts[12], acct13: accts[13], acct16: accts[16], acct17: accts[17] },
                            disc,
                        });
                    } else if (accts.length === 16 && disc === '33e685a4017f83ad' && !sell) {
                        sell = { fee2: accts[8], acct14: accts[14], acct15: accts[15] };
                    }
                }
            }
            if (!buys.length) { this.lastError = 'no-template (no harvestable buys in retention)'; return null; }
            // Consistency: all observed buys must agree on every slot.
            for (const b of buys.slice(1)) {
                for (const k of Object.keys(b.slots) as (keyof typeof b.slots)[]) {
                    if (b.slots[k] !== buys[0].slots[k]) {
                        this.lastError = `template inconsistent across buys (slot ${k})`;
                        return null;
                    }
                }
            }
            discSeen = buys[0].disc;
            const t: Template = { buy: buys[0].slots, sell, at: Date.now(), disc: discSeen, buysSampled: buys.length };
            this.templates.set(mint, t);
            this.loadTemplateDisk().set(mint, t);
            this.saveTemplateDisk();
            return t;
        } catch (e: any) {
            this.lastError = `harvest failed: ${e.message}`;
            return null;
        }
    }

    private computeBudgetIxs(): TransactionInstruction[] {
        const cuLimit = Number(process.env.CURVE_CU_LIMIT || 150_000);
        const micro = this.feeMicro ?? Number(process.env.CURVE_PRIORITY_MICROLAMPORTS || 2_000);
        return [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }),
        ];
    }

    private createAtaIdempotentIx(owner: PublicKey, mint: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: ATA_PROG,
            keys: [
                { pubkey: owner, isSigner: true, isWritable: true },
                { pubkey: ata(mint, owner), isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SYSTEM, isSigner: false, isWritable: false },
                { pubkey: TOKEN22, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([1]),
        });
    }

    private closeAccountIx(account: PublicKey, owner: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: TOKEN22,
            keys: [
                { pubkey: account, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]),
        });
    }

    async buy(mint: string, solIn: number, slippageBps: number, _tipLamports: number): Promise<string | null> {
        const ixs = await this.buildBuyIxs(mint, solIn, slippageBps);
        if (!ixs) return null;
        return await this.buildAndSend(ixs);
    }

    // Free simulation of the exact buy path (probe ladder stage: proves the
    // deployed program accepts our disc + account list; an unfunded payer
    // fails only at the funding/ATA stage, never at instruction decode).
    async simBuy(mint: string, solIn: number): Promise<any | null> {
        const ixs = await this.buildBuyIxs(mint, solIn, 1_000);
        if (!ixs) return null;
        const { blockhash, lastValidBlockHeight } = await this.connection!.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: this.keypair!.publicKey, blockhash, lastValidBlockHeight });
        tx.add(...ixs);
        tx.sign(this.keypair!);
        return await (this.connection as any).simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    }

    private async buildBuyIxs(mint: string, solIn: number, slippageBps: number): Promise<TransactionInstruction[] | null> {
        try {
            if (!this.keypair) { this.lastError = 'broker not armed'; return null; }
            const st = await this.fetchCurveState(mint);
            if (!st || !st.userAta) return null;
            const tpl = await this.fetchTemplate(mint);
            if (!tpl || !tpl.buy) return null;
            const q = BigInt(Math.floor(solIn * 1e9));
            const net = (q * (10_000n - FEE_BPS)) / 10_000n;
            const out = st.vTok - (st.vTok * st.vSol) / (st.vSol + net);
            if (out <= 0n) { this.lastError = 'zero curve quote'; return null; }
            const slip = BigInt(Math.max(0, Math.min(9_999, slippageBps)));
            const minOut = (out * (10_000n - slip)) / 10_000n;
            const keys = [
                { pubkey: pda([Buffer.from('global')], PUMP), isSigner: false, isWritable: false },
                { pubkey: new PublicKey(tpl.buy!.fee1), isSigner: false, isWritable: true },
                { pubkey: st.mint, isSigner: false, isWritable: false },
                { pubkey: st.curve, isSigner: false, isWritable: true },
                { pubkey: ata(st.mint, st.curve), isSigner: false, isWritable: true },
                { pubkey: st.userAta!, isSigner: false, isWritable: true },
                { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
                { pubkey: SYSTEM, isSigner: false, isWritable: false },
                { pubkey: TOKEN22, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(tpl.buy!.acct9), isSigner: false, isWritable: true },
                { pubkey: pda([Buffer.from('__event_authority')], PUMP), isSigner: false, isWritable: false },
                { pubkey: PUMP, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(tpl.buy!.acct12), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(tpl.buy!.acct13), isSigner: false, isWritable: true },
                { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
                { pubkey: PFEE, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(tpl.buy!.acct16), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(tpl.buy!.acct17), isSigner: false, isWritable: true },
            ];
            const ixs = this.computeBudgetIxs();
            if (!st.userAtaExists) ixs.push(this.createAtaIdempotentIx(this.keypair.publicKey, st.mint));
            ixs.push(new TransactionInstruction({
                programId: PUMP,
                keys,
                data: Buffer.concat([DISC_BUY, u64le(minOut), u64le(q), Buffer.from([0])]),
            }));
            return ixs;
        } catch (e: any) {
            this.lastError = `buy failed: ${e.message}`;
            return null;
        }
    }

    async sell(mint: string, tokenRawAmount: string, slippageBps: number, _tipLamports: number): Promise<string | null> {
        try {
            if (!this.keypair) { this.lastError = 'broker not armed'; return null; }
            const st = await this.fetchCurveState(mint);
            if (!st || !st.userAta || !st.userAtaExists) { this.lastError = 'no token account — nothing to sell'; return null; }
            const tpl = await this.fetchTemplate(mint);
            if (!tpl) return null;
            const b = BigInt(tokenRawAmount);
            const grossSol = st.vSol - (st.vTok * st.vSol) / (st.vTok + b);
            const netSol = (grossSol * (10_000n - FEE_BPS)) / 10_000n;
            const slip = BigInt(Math.max(0, Math.min(9_999, slippageBps)));
            const minOut = (netSol * (10_000n - slip)) / 10_000n;
            if (minOut < 1n) { this.lastError = 'estimated proceeds under slippage floor are zero — aborting'; return null; }
            // Sell-side unknowns: prefer a real sell template; else map the buy
            // template's pfee records ([16]->[14], [17]->[15] families).
            const fee2 = tpl.sell ? tpl.sell.fee2 : tpl.buy!.acct16;
            const acct14 = tpl.sell ? tpl.sell.acct14 : tpl.buy!.acct16;
            const acct15 = tpl.sell ? tpl.sell.acct15 : tpl.buy!.acct17;
            const keys = [
                { pubkey: pda([Buffer.from('global')], PUMP), isSigner: false, isWritable: false },
                { pubkey: new PublicKey(tpl.buy!.fee1), isSigner: false, isWritable: true },
                { pubkey: st.mint, isSigner: false, isWritable: false },
                { pubkey: st.curve, isSigner: false, isWritable: true },
                { pubkey: ata(st.mint, st.curve), isSigner: false, isWritable: true },
                { pubkey: st.userAta!, isSigner: false, isWritable: true },
                { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
                { pubkey: SYSTEM, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(fee2), isSigner: false, isWritable: true },
                { pubkey: TOKEN22, isSigner: false, isWritable: false },
                { pubkey: pda([Buffer.from('__event_authority')], PUMP), isSigner: false, isWritable: false },
                { pubkey: PUMP, isSigner: false, isWritable: false },
                { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
                { pubkey: PFEE, isSigner: false, isWritable: false },
                { pubkey: new PublicKey(acct14), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(acct15), isSigner: false, isWritable: true },
            ];
            const ixs = this.computeBudgetIxs();
            ixs.push(new TransactionInstruction({ programId: PUMP, keys, data: Buffer.concat([DISC_SELL, u64le(b), u64le(minOut)]) }));
            // Full-balance sell: recover the base-ATA rent in the exit tx.
            ixs.push(this.closeAccountIx(st.userAta!, this.keypair.publicKey));
            return await this.buildAndSend(ixs);
        } catch (e: any) {
            this.lastError = `sell failed: ${e.message}`;
            return null;
        }
    }

    // Plain-RPC landing: preflight on (failed sims are free), then poll to
    // confirmation — submitted-accepted is not a fill.
    private async buildAndSend(ixs: TransactionInstruction[]): Promise<string | null> {
        const { blockhash, lastValidBlockHeight } = await this.connection!.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: this.keypair!.publicKey, blockhash, lastValidBlockHeight });
        tx.add(...ixs);
        tx.sign(this.keypair!);
        const raw = tx.serialize();
        const sig = await this.connection!.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
        for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 3_000));
            const status = await this.connection!.getSignatureStatus(sig, { searchTransactionHistory: true });
            const val = status?.value?.confirmationStatus;
            if (val === 'confirmed' || val === 'finalized') return sig;
            if (status?.value?.err) { this.lastError = 'tx executed and failed on-chain'; return null; }
        }
        this.lastError = 'tx dropped: not seen on-chain within the blockhash window';
        return null;
    }
}
