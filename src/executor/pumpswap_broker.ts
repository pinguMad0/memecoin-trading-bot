// Direct PumpSwap broker. It builds v2 swap instructions, estimates prices
// from pool reserves, and submits through plain RPC with a priority fee.
// The runner can use this instead of the Jupiter broker without changing
// its interface. SOL is wrapped only for the duration of each swap.
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    ComputeBudgetProgram,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Program/address constants (all derived at load, never hand-copied).
// ---------------------------------------------------------------------------
const PAMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PFEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = SystemProgram.programId;

const POOL_DISC = Buffer.from('f19a6d0411b16dbc', 'hex');
const DISC_BUY = Buffer.from('c2ab1c46684d5b2f', 'hex'); // buy_exact_quote_in_v2
const DISC_SELL = Buffer.from('5df6823ce7e940b2', 'hex'); // sell_v2
const DISC_INIT_UVA = Buffer.from('5e06ca73ff60e8b7', 'hex'); // init_user_volume_accumulator

function pda(seeds: Buffer[], program: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program)[0];
}
function pk(buf: Buffer): PublicKey {
    return new PublicKey(buf);
}

const GLOBAL_CONFIG = pda([Buffer.from('global_config')], PAMM);
const EVENT_AUTH = pda([Buffer.from('__event_authority')], PAMM);
const FEE_CONFIG = pda([Buffer.from('fee_config'), PAMM.toBuffer()], PFEE);

// ATA seeds are [owner, TOKEN_PROGRAM_OF_MINT, mint] under the ATA program.
function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
    return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROG);
}
// Canonical pump pool: ["pool", u16le(0), pool-authority(mint), mint, WSOL].
function poolAuthorityPda(mint: PublicKey): PublicKey {
    return pda([Buffer.from('pool-authority'), mint.toBuffer()], PUMP);
}
export function canonicalPoolPda(mint: PublicKey): PublicKey {
    const idx = Buffer.alloc(2);
    idx.writeUInt16LE(0);
    return pda(
        [Buffer.from('pool'), idx, poolAuthorityPda(mint).toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()],
        PAMM,
    );
}
function uvaPda(user: PublicKey): PublicKey {
    return pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PAMM);
}

function u64le(v: bigint): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
}

// ---------------------------------------------------------------------------
// Pool + global-config decoding.
// ---------------------------------------------------------------------------
export interface PoolStateLive {
    pool: PublicKey;
    baseMint: PublicKey;
    baseVault: PublicKey;
    quoteVault: PublicKey;
    baseTokenProgram: PublicKey;
    baseVaultBal: bigint;
    quoteVaultBal: bigint;
    virtualQuote: bigint; // adds to effective quote reserves for pricing
    feeBuckets: bigint; // protocol_fees + creator_fees: not payable to sellers
    coinCreatorIsSet: boolean;
    // user-side state (null when no wallet supplied)
    userWsolAta: PublicKey | null;
    userWsolAtaExists: boolean;
    userBaseAta: PublicKey | null;
    userBaseAtaExists: boolean;
    uva: PublicKey | null;
    uvaExists: boolean;
}

// Pool account layout (offsets after the 8-byte disc), verified on-chain:
// bump@8 idx@9 creator@11 base_mint@43 quote_mint@75 lp_mint@107
// pool_base_vault@139 pool_quote_vault@171 lp_supply@203 coin_creator@211
// is_mayhem@243 is_cashback@244 virtual_quote@245(i128)
// [261B pre-upgrade pools end here]
// creator_fee_bps@261 can_edit@269 is_holder@270 protocol_fees@271 creator_fees@279.
function decodePool(data: Buffer, poolAddr: PublicKey, wantMint: PublicKey): Omit<PoolStateLive, 'baseVaultBal' | 'quoteVaultBal' | 'userWsolAtaExists' | 'userBaseAtaExists' | 'uvaExists'> | null {
    if (data.length < 261 || !data.subarray(0, 8).equals(POOL_DISC)) return null;
    const baseMint = pk(data.subarray(43, 75));
    const quoteMint = pk(data.subarray(75, 107));
    if (!quoteMint.equals(WSOL_MINT) || !baseMint.equals(wantMint)) return null;
    if (data[244] !== 0) return null; // cashback coin: v2 unsupported — fail closed
    const baseVault = pk(data.subarray(139, 171));
    const quoteVault = pk(data.subarray(171, 203));
    // The base token program is whichever ATA derivation matches the vault.
    let baseTokenProgram: PublicKey | null = null;
    if (ata(baseMint, poolAddr, TOKEN22).equals(baseVault)) baseTokenProgram = TOKEN22;
    else if (ata(baseMint, poolAddr, TOKEN).equals(baseVault)) baseTokenProgram = TOKEN;
    if (!baseTokenProgram) return null;
    const vLo = BigInt(data.readBigUInt64LE(245));
    const vHi = BigInt(data.readBigInt64LE(253));
    const virtualQuote = (vHi << 64n) | vLo;
    let feeBuckets = 0n;
    if (data.length >= 287) {
        feeBuckets = BigInt(data.readBigUInt64LE(271)) + BigInt(data.readBigUInt64LE(279));
    }
    const coinCreator = pk(data.subarray(211, 243));
    return {
        pool: poolAddr,
        baseMint,
        baseVault,
        quoteVault,
        baseTokenProgram,
        virtualQuote: virtualQuote > 0n ? virtualQuote : 0n,
        feeBuckets,
        coinCreatorIsSet: !coinCreator.equals(SYSTEM),
        userWsolAta: null,
        userBaseAta: null,
        uva: null,
    };
}

// GlobalConfig (949B): lp_fee_bps@40 protocol_fee_bps@48 creator_fee_bps@313
// buyback_fee_recipients[8]@643. Used for pricing estimates and the v2
// buyback-recipient slot (the program accepts any listed recipient —
// selection is client-side, mirroring pump-swap-sdk).
interface FeeSchedule {
    lpBps: bigint;
    protocolBps: bigint;
    creatorBps: bigint;
    buybackRecipients: PublicKey[];
}

export class PumpSwapBroker {
    private keypair: Keypair | null = null;
    private connection: Connection | null = null;
    public lastError: string | null = null;
    private feeSchedule: FeeSchedule | null = null;
    private feeScheduleAt = 0;
    private decimalsCache = new Map<string, number | null>();
    private solUsdCache: { usd: number | null; at: number } = { usd: null, at: 0 };
    // Cache the current priority-fee estimate and refresh it in the background.
    private feeMicro: number | null = null;

    constructor(private enabled: boolean, privateKeyBase58: string | null, rpcUrl: string | null) {
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
        if (this.connection) {
            this.refreshFeeOracle();
            const timer = setInterval(() => this.refreshFeeOracle(), 30_000);
            if (typeof timer.unref === 'function') timer.unref();
        }
    }

    // Live priority-fee estimate in microLamports (Helius priorityLevel
    // semantics: Min..UnsafeMax; default High = the level that lands under
    // congestion). Multiplied, capped, and cached; any failure keeps the
    // last-known value, and computeBudgetIxs falls back to the static env
    // default when the oracle has never answered.
    private async refreshFeeOracle(): Promise<void> {
        if (!this.connection) return;
        try {
            const level = process.env.PUMP_FEE_LEVEL || 'High';
            const resp = await (this.connection as any)._rpcRequest('getPriorityFeeEstimate', [{
                accountKeys: [GLOBAL_CONFIG.toBase58()],
                options: {
                    priorityLevel: level,
                    lookbackSlots: 150,
                    includeVote: false,
                    evaluateEmptySlotAsZero: true,
                },
            }]);
            const est = resp?.result?.priorityFeeEstimate;
            if (typeof est === 'number' && est >= 0) {
                const mult = Number(process.env.PUMP_FEE_MULT || 1);
                const cap = Number(process.env.PUMP_PRIORITY_MICROLAMPORTS_MAX || 700_000);
                this.feeMicro = Math.max(1, Math.min(Math.ceil(est * mult), cap));
            }
        } catch { /* keep last-known estimate */ }
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    get walletPubkey(): string | null {
        return this.keypair ? this.keypair.publicKey.toBase58() : null;
    }

    async getWalletBalance(): Promise<number> {
        const bal = await this.connection!.getBalance(this.keypair!.publicKey, 'confirmed');
        return bal / 1e9;
    }

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

    async getTokenBalance(mint: string): Promise<number | null> {
        if (!this.enabled || !this.connection || !this.keypair) return null;
        try {
            const res = await this.connection.getParsedTokenAccountsByOwner(
                this.keypair.publicKey,
                { mint: new PublicKey(mint) },
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

    // SOL/USD via CoinGecko (probe pricing only), cached 60s, stale fallback.
    async getSolUsd(): Promise<number | null> {
        const now = Date.now();
        if (this.solUsdCache.usd !== null && now - this.solUsdCache.at < 60_000) {
            return this.solUsdCache.usd;
        }
        try {
            const r = await (await fetch(
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            )).json();
            const usd = Number(r?.solana?.usd);
            if (usd > 0) {
                this.solUsdCache = { usd, at: now };
                return usd;
            }
        } catch { /* fall through to last-known */ }
        return this.solUsdCache.usd;
    }

    // ------------------------------------------------------------------------
    // Pool state fetch: one getMultipleAccounts round trip for everything
    // (pool + both vaults + user-side accounts).
    // ------------------------------------------------------------------------
    private async fetchPoolState(mintStr: string, user: PublicKey | null): Promise<PoolStateLive | null> {
        const mint = new PublicKey(mintStr);
        const poolAddr = canonicalPoolPda(mint);
        const baseVaultT22 = ata(mint, poolAddr, TOKEN22);
        const baseVaultLegacy = ata(mint, poolAddr, TOKEN);
        const quoteVault = ata(WSOL_MINT, poolAddr, TOKEN);
        const keys: PublicKey[] = [poolAddr, baseVaultT22, baseVaultLegacy, quoteVault];
        const userWsolAta = user ? ata(WSOL_MINT, user, TOKEN) : null;
        const userBaseAtaT22 = user ? ata(mint, user, TOKEN22) : null;
        const userBaseAtaLegacy = user ? ata(mint, user, TOKEN) : null;
        const uva = user ? uvaPda(user) : null;
        if (user && userWsolAta && userBaseAtaT22 && userBaseAtaLegacy && uva) {
            keys.push(userWsolAta, userBaseAtaT22, userBaseAtaLegacy, uva);
        }
        const infos = await this.connection!.getMultipleAccountsInfo(keys);
        const poolInfo = infos[0];
        if (!poolInfo || !new PublicKey(poolInfo.owner).equals(PAMM)) {
            this.lastError = 'canonical pAMM pool not found (not graduated?)';
            return null;
        }
        const decoded = decodePool(Buffer.from(poolInfo.data), poolAddr, mint);
        if (!decoded) {
            this.lastError = 'pool decode failed (not a canonical WSOL pool / cashback coin)';
            return null;
        }
        // Pick the vault info that matches the pool's stored vault address.
        const useT22 = decoded.baseVault.equals(baseVaultT22);
        const baseVaultInfo = useT22 ? infos[1] : infos[2];
        const quoteVaultInfo = infos[3];
        if (!baseVaultInfo || !quoteVaultInfo) {
            this.lastError = 'pool vault account missing on-chain';
            return null;
        }
        const bal = (info: { data: Buffer }) => BigInt(info.data.readBigUInt64LE(64));
        const st: PoolStateLive = {
            ...decoded,
            baseVaultBal: bal(baseVaultInfo),
            quoteVaultBal: bal(quoteVaultInfo),
            userWsolAta,
            userWsolAtaExists: !!(user && infos[4]),
            userBaseAta: null,
            userBaseAtaExists: false,
            uva,
            uvaExists: !!(user && infos[7]),
        };
        if (user) {
            // user base ATA lives under the base token program
            if (decoded.baseTokenProgram.equals(TOKEN22)) {
                st.userBaseAta = userBaseAtaT22;
                st.userBaseAtaExists = !!infos[5];
            } else {
                st.userBaseAta = userBaseAtaLegacy;
                st.userBaseAtaExists = !!infos[6];
            }
        }
        return st;
    }

    private async getFeeSchedule(): Promise<FeeSchedule | null> {
        const now = Date.now();
        if (this.feeSchedule && now - this.feeScheduleAt < 600_000) return this.feeSchedule;
        const info = await this.connection!.getAccountInfo(GLOBAL_CONFIG);
        if (!info) {
            this.lastError = 'global config account missing';
            return null;
        }
        const d = Buffer.from(info.data);
        const buybackRecipients: PublicKey[] = [];
        for (let i = 0; i < 8; i++) {
            const cand = pk(d.subarray(643 + i * 32, 675 + i * 32));
            if (!cand.equals(SYSTEM)) buybackRecipients.push(cand);
        }
        this.feeSchedule = {
            lpBps: BigInt(d.readBigUInt64LE(40)),
            protocolBps: BigInt(d.readBigUInt64LE(48)),
            creatorBps: BigInt(d.readBigUInt64LE(313)),
            buybackRecipients,
        };
        this.feeScheduleAt = now;
        return this.feeSchedule;
    }

    private totalBps(f: FeeSchedule, st: PoolStateLive): bigint {
        return f.lpBps + f.protocolBps + (st.coinCreatorIsSet ? f.creatorBps : 0n);
    }

    // CP pricing on effective reserves (quote vault + virtual subsidy), the
    // fee split taken off the input first — mirrors pump-amm trade_v2 math.
    estimateBuyOut(st: PoolStateLive, f: FeeSchedule, quoteIn: bigint): bigint | null {
        const Qeff = st.quoteVaultBal + st.virtualQuote;
        if (st.baseVaultBal <= 0n || Qeff <= 0n) {
            this.lastError = 'pool reserves are zero';
            return null;
        }
        const net = (quoteIn * 10_000n) / (10_000n + this.totalBps(f, st));
        return (st.baseVaultBal * net) / (Qeff + net);
    }

    estimateSellOut(st: PoolStateLive, f: FeeSchedule, baseIn: bigint): bigint | null {
        const Qeff = st.quoteVaultBal + st.virtualQuote;
        if (st.baseVaultBal <= 0n || Qeff <= 0n) {
            this.lastError = 'pool reserves are zero';
            return null;
        }
        const gross = (Qeff * baseIn) / (st.baseVaultBal + baseIn);
        const userOut = gross - (gross * this.totalBps(f, st)) / 10_000n;
        // Fees accrued in the vault are not payable to sellers — cap there.
        const realQuote = st.quoteVaultBal > st.feeBuckets ? st.quoteVaultBal - st.feeBuckets : 0n;
        return userOut > realQuote ? realQuote : userOut;
    }

    // ------------------------------------------------------------------------
    // Local quote (probe parity with the old Jupiter path).
    // ------------------------------------------------------------------------

    // Marginal USD/token sell price implied by current pool reserves.
    async poolPrice(mint: string): Promise<number | null> {
        try {
            const st = await this.fetchPoolState(mint, null);
            if (!st) return null;
            const f = await this.getFeeSchedule();
            if (!f) return null;
            const B = st.baseVaultBal;
            if (B <= 0n) {
                this.lastError = 'pool base reserve is zero';
                return null;
            }
            const probe = B / 1000n > 0n ? B / 1000n : 1n; // ~0.1% probe: impact ~0
            const out = this.estimateSellOut(st, f, probe);
            if (out === null || out <= 0n) {
                this.lastError = 'pool price probe failed';
                return null;
            }
            const lamportsPerRaw = Number(out) / Number(probe);
            const dec = await this.getMintDecimals(mint);
            if (dec === null) return null;
            const solUsd = await this.getSolUsd();
            if (!solUsd) return null;
            const solPerToken = (lamportsPerRaw * Math.pow(10, dec)) / 1e9;
            return solPerToken * solUsd;
        } catch (e: any) {
            this.lastError = `poolPrice failed: ${e.message}`;
            return null;
        }
    }

    async quoteBuy(mint: string, amountSol: number, _slippageBps: number): Promise<{
        quote: any;
        inAmountLamports: number;
        outAmountRaw: string;
        priceImpactPct: number;
    } | null> {
        try {
            const st = await this.fetchPoolState(mint, null);
            if (!st) return null;
            const f = await this.getFeeSchedule();
            if (!f) return null;
            const q = BigInt(Math.floor(amountSol * 1e9));
            const out = this.estimateBuyOut(st, f, q);
            if (out === null || out <= 0n) {
                this.lastError = this.lastError || 'zero estimated output';
                return null;
            }
            const Qeff = st.quoteVaultBal + st.virtualQuote;
            return {
                quote: { routePlan: [{ swapInfo: { label: 'PumpSwap v2 direct' } }] },
                inAmountLamports: Number(q),
                outAmountRaw: out.toString(),
                priceImpactPct: Number((q * 10_000n) / Qeff) / 100,
            };
        } catch (e: any) {
            this.lastError = `local quote failed: ${e.message}`;
            return null;
        }
    }

    // ------------------------------------------------------------------------
    // Instruction builders.
    // ------------------------------------------------------------------------
    private computeBudgetIxs(): TransactionInstruction[] {
        // Keep the CU limit tight and cap the fee estimate.
        const cuLimit = Number(process.env.PUMP_CU_LIMIT || 150_000);
        const micro = this.feeMicro ?? Number(process.env.PUMP_PRIORITY_MICROLAMPORTS || 2_000);
        return [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }),
        ];
    }

    // AssociatedTokenAccount: CreateIdempotent (index 1) — succeeds even when
    // the account already exists. Account order per the deployed program
    // (verified against our live Jupiter fills): system program comes BEFORE
    // the token program, the post-Token-2022 layout.
    private createAtaIdempotentIx(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
        const account = ata(mint, owner, tokenProgram);
        return new TransactionInstruction({
            programId: ATA_PROG,
            keys: [
                { pubkey: owner, isSigner: true, isWritable: true },
                { pubkey: account, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SYSTEM, isSigner: false, isWritable: false },
                { pubkey: tokenProgram, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([1]),
        });
    }

    // Token program SyncNative (index 17): folds lamports (wrap transfer +
    // rent) into the WSOL token amount. Without it the token amount stays 0
    // and every swap debit fails with "insufficient funds" — the wrap is not
    // complete until this runs (the step Jupiter's wrapper always included).
    private syncNativeIx(account: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: TOKEN,
            keys: [{ pubkey: account, isSigner: false, isWritable: true }],
            data: Buffer.from([17]),
        });
    }

    // Token CloseAccount (index 9): unwrap WSOL (legacy program) or close an
    // empty Token-2022 token account (base ATA after a full sell — the rent
    // returns to the wallet in the exit tx; no Phantom-sweep dependency).
    private closeAccountIx(account: PublicKey, owner: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: tokenProgram,
            keys: [
                { pubkey: account, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]),
        });
    }

    private initUvaIx(payer: PublicKey, user: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: PAMM,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: user, isSigner: false, isWritable: false },
                { pubkey: uvaPda(user), isSigner: false, isWritable: true },
                { pubkey: SYSTEM, isSigner: false, isWritable: false },
                { pubkey: EVENT_AUTH, isSigner: false, isWritable: false },
                { pubkey: PAMM, isSigner: false, isWritable: false },
            ],
            data: DISC_INIT_UVA,
        });
    }

    // The 17 v2 accounts, IDL order, w/S flags from our real fills.
    private swapAccounts(st: PoolStateLive, user: PublicKey, userBase: PublicKey, userQuote: PublicKey, buybackAta: PublicKey): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
        return [
            { pubkey: st.pool, isSigner: false, isWritable: true },
            { pubkey: user, isSigner: true, isWritable: false },
            { pubkey: GLOBAL_CONFIG, isSigner: false, isWritable: false },
            { pubkey: st.baseMint, isSigner: false, isWritable: false },
            { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
            { pubkey: userBase, isSigner: false, isWritable: true },
            { pubkey: userQuote, isSigner: false, isWritable: true },
            { pubkey: st.baseVault, isSigner: false, isWritable: true },
            { pubkey: st.quoteVault, isSigner: false, isWritable: true },
            { pubkey: st.baseTokenProgram, isSigner: false, isWritable: false },
            { pubkey: TOKEN, isSigner: false, isWritable: false },
            { pubkey: SYSTEM, isSigner: false, isWritable: false },
            { pubkey: uvaPda(user), isSigner: false, isWritable: true },
            { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
            { pubkey: buybackAta, isSigner: false, isWritable: true },
            { pubkey: EVENT_AUTH, isSigner: false, isWritable: false },
            { pubkey: PAMM, isSigner: false, isWritable: false },
        ];
    }

    private pickBuybackAta(f: FeeSchedule): PublicKey {
        const recip = f.buybackRecipients[Math.floor(Math.random() * f.buybackRecipients.length)];
        return ata(WSOL_MINT, recip, TOKEN);
    }

    // ------------------------------------------------------------------------
    // Trade entry points (gated, same contract as LiveBroker).
    // ------------------------------------------------------------------------
    async buy(mint: string, amountSol: number, slippageBps: number, _unusedTip: number): Promise<string | null> {
        if (!this.enabled || !this.keypair || !this.connection) {
            this.lastError = 'buy blocked: live gate is closed';
            return null;
        }
        try {
            const wallet = this.keypair.publicKey;
            const q = BigInt(Math.floor(amountSol * 1e9));
            const st = await this.fetchPoolState(mint, wallet);
            if (!st || !st.userWsolAta || !st.userBaseAta || !st.uva) return null;
            const f = await this.getFeeSchedule();
            if (!f) return null;
            const est = this.estimateBuyOut(st, f, q);
            if (est === null) return null;
            const slip = BigInt(Math.max(0, Math.min(9_999, slippageBps)));
            const minOut = (est * (10_000n - slip)) / 10_000n;
            if (minOut < 1n) {
                this.lastError = 'estimated output under slippage floor is zero — aborting';
                return null;
            }
            const ixs: TransactionInstruction[] = this.computeBudgetIxs();
            if (!st.uvaExists) ixs.push(this.initUvaIx(wallet, wallet));
            if (!st.userWsolAtaExists) ixs.push(this.createAtaIdempotentIx(wallet, WSOL_MINT, TOKEN));
            if (!st.userBaseAtaExists) ixs.push(this.createAtaIdempotentIx(wallet, st.baseMint, st.baseTokenProgram));
            ixs.push(SystemProgram.transfer({
                fromPubkey: wallet,
                toPubkey: st.userWsolAta,
                lamports: Number(q),
            }));
            ixs.push(this.syncNativeIx(st.userWsolAta));
            ixs.push(new TransactionInstruction({
                programId: PAMM,
                keys: this.swapAccounts(st, wallet, st.userBaseAta, st.userWsolAta, this.pickBuybackAta(f)),
                data: Buffer.concat([DISC_BUY, u64le(q), u64le(minOut)]),
            }));
            ixs.push(this.closeAccountIx(st.userWsolAta, wallet, TOKEN));
            return await this.buildAndSend(ixs);
        } catch (e: any) {
            this.lastError = `buy failed: ${e.message}`;
            return null;
        }
    }

    async sell(mint: string, tokenRawAmount: string, slippageBps: number, _unusedTip: number): Promise<string | null> {
        if (!this.enabled || !this.keypair || !this.connection) {
            this.lastError = 'sell blocked: live gate is closed';
            return null;
        }
        try {
            const wallet = this.keypair.publicKey;
            const b = BigInt(tokenRawAmount);
            if (b <= 0n) {
                this.lastError = 'sell amount must be positive';
                return null;
            }
            const st = await this.fetchPoolState(mint, wallet);
            if (!st || !st.userWsolAta || !st.userBaseAta || !st.uva) return null;
            if (!st.userBaseAtaExists) {
                this.lastError = 'no token account — nothing to sell';
                return null;
            }
            const f = await this.getFeeSchedule();
            if (!f) return null;
            const est = this.estimateSellOut(st, f, b);
            if (est === null) return null;
            const slip = BigInt(Math.max(0, Math.min(9_999, slippageBps)));
            const minOut = (est * (10_000n - slip)) / 10_000n;
            if (minOut < 1n) {
                this.lastError = 'estimated proceeds under slippage floor are zero — aborting';
                return null;
            }
            const ixs: TransactionInstruction[] = this.computeBudgetIxs();
            if (!st.uvaExists) ixs.push(this.initUvaIx(wallet, wallet));
            if (!st.userWsolAtaExists) ixs.push(this.createAtaIdempotentIx(wallet, WSOL_MINT, TOKEN));
            ixs.push(new TransactionInstruction({
                programId: PAMM,
                keys: this.swapAccounts(st, wallet, st.userBaseAta, st.userWsolAta, this.pickBuybackAta(f)),
                data: Buffer.concat([DISC_SELL, u64le(b), u64le(minOut)]),
            }));
            // Close the empty base account to recover its rent.
            if (st.userBaseAta) {
                ixs.push(this.closeAccountIx(st.userBaseAta, wallet, st.baseTokenProgram));
            }
            ixs.push(this.closeAccountIx(st.userWsolAta, wallet, TOKEN));
            return await this.buildAndSend(ixs);
        } catch (e: any) {
            this.lastError = `sell failed: ${e.message}`;
            return null;
        }
    }

    // Preflight first, then wait for on-chain confirmation.
    private async buildAndSend(ixs: TransactionInstruction[]): Promise<string | null> {
        const { blockhash } = await this.connection!.getLatestBlockhash('confirmed');
        const tx = new Transaction();
        for (const ix of ixs) tx.add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.keypair!.publicKey;
        tx.sign(this.keypair!);
        const sig = await this.connection!.sendRawTransaction(
            Buffer.from(tx.serialize()),
            { skipPreflight: false, maxRetries: 5 },
        );
        const landed = await this.confirmLanded(sig);
        return landed ? sig : null;
    }

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
}
