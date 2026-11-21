// Logs pool-drain risk features without blocking trades. It checks the
// reference price, momentum, liquidity, holder clusters, and the share of
// real SOL left in the pool. Thresholds are configurable in the environment.
import { Connection, PublicKey } from '@solana/web3.js';

const PUMP_PROG = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PAMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROG = new PublicKey('ATokenGPvbdgxrpVzKhtMpwXtMVLs7HSKdJD3nd7STXo');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const POOL_DISC = Buffer.from('f19a6d0411b16dbc', 'hex');

export interface DrainAuditInput {
    ref_price: number | null;
    trigger_price: number | null;
    liq_usd: number | null;
    audit?: {
        top5_pct?: number[];
        top10_pct?: number;
        same_balance_cluster?: number;
        uniform_cluster?: number;
    } | null;
}

export interface DrainAuditResult {
    status: 'ok' | 'unavailable';
    risk: 'low' | 'elevated' | 'high';
    score: number;
    flags: string[];
    features: {
        ref_price: number | null;
        momentum_pct: number | null;
        liq_usd: number | null;
        top1_pct: number | null;
        top10_pct: number | null;
        same_balance_cluster: number | null;
        uniform_cluster: number | null;
        signal_pool: string | null;
        canonical_pool: string | null;
        canonical_pool_alive: boolean | null;
        pool_real_sol: number | null;
        pool_virtual_quote: number | null;
        pool_real_share_pct: number | null;
        pool_can_edit: number | null;
        pool_is_holder: number | null;
        pool_coin_creator: string | null;
        pool_creator: string | null;
    };
}

let _conn: Connection | null = null;
function conn(): Connection {
    if (!_conn) {
        _conn = new Connection(
            process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed',
        );
    }
    return _conn;
}

function pda(seeds: Buffer[], program: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, program)[0];
}

function canonicalPoolPda(mint: PublicKey): PublicKey {
    const authority = pda([Buffer.from('pool-authority'), mint.toBuffer()], PUMP_PROG);
    const idx = Buffer.alloc(2);
    idx.writeUInt16LE(0);
    return pda(
        [Buffer.from('pool'), idx, authority.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()],
        PAMM,
    );
}

function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
    return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROG);
}

function decodePool(data: Buffer): {
    quoteVault: PublicKey;
    realSol: bigint;
    virtualQuote: bigint;
    canEdit: number;
    isHolder: number;
    coinCreator: string;
    creator: string;
} | null {
    if (data.length < 261 || !data.subarray(0, 8).equals(POOL_DISC)) return null;
    const quoteVault = new PublicKey(data.subarray(171, 203));
    const vLo = BigInt(data.readBigUInt64LE(245));
    const vHi = BigInt(data.readBigInt64LE(253));
    const virtualQuote = (vHi << 64n) | vLo;
    const canEdit = data.length > 269 ? data[269] : -1;
    const isHolder = data.length > 270 ? data[270] : -1;
    const coinCreator = new PublicKey(data.subarray(211, 243)).toBase58();
    const creator = new PublicKey(data.subarray(11, 43)).toBase58();
    return {
        quoteVault,
        realSol: 0n,
        virtualQuote: virtualQuote > 0n ? virtualQuote : 0n,
        canEdit,
        isHolder,
        coinCreator,
        creator,
    };
}

export async function drainAudit(
    mintS: string,
    signalPoolS: string,
    input: DrainAuditInput,
): Promise<DrainAuditResult> {
    const REF_MIN = Number(process.env.DRAIN_REF_PRICE_MIN || 1e-4);
    const MOM_MAX = Number(process.env.DRAIN_MOM_MAX_PCT || 0.5);
    const LIQ_MIN = Number(process.env.DRAIN_LIQ_MIN_USD || 45_000);
    const REAL_SHARE_MIN = Number(process.env.DRAIN_POOL_REAL_SHARE_MIN_PCT || 50);
    const BUNDLE_MIN = Number(process.env.DRAIN_BUNDLE_MIN_CLUSTER || 3);

    const top5 = input.audit?.top5_pct || [];
    const top1 = top5.length ? top5[0] : null;
    const sameBalance = input.audit?.same_balance_cluster ?? null;
    const uniform = input.audit?.uniform_cluster ?? null;
    const momentum =
        input.ref_price && input.trigger_price ? input.trigger_price / input.ref_price - 1 : null;

    const features: DrainAuditResult['features'] = {
        ref_price: input.ref_price,
        momentum_pct: momentum,
        liq_usd: input.liq_usd,
        top1_pct: top1,
        top10_pct: input.audit?.top10_pct ?? null,
        same_balance_cluster: sameBalance,
        uniform_cluster: uniform,
        signal_pool: signalPoolS || null,
        canonical_pool: null,
        canonical_pool_alive: null,
        pool_real_sol: null,
        pool_virtual_quote: null,
        pool_real_share_pct: null,
        pool_can_edit: null,
        pool_is_holder: null,
        pool_coin_creator: null,
        pool_creator: null,
    };

    const flags: string[] = [];
    if (input.ref_price !== null && input.ref_price < REF_MIN) flags.push('low_ref_price');
    if (momentum !== null && momentum >= MOM_MAX) flags.push('high_momentum');
    if (input.liq_usd !== null && input.liq_usd < LIQ_MIN) flags.push('thin_liquidity');
    if (sameBalance !== null && sameBalance < BUNDLE_MIN) flags.push('no_sniper_bundle');
    if (top1 !== null && top1 <= 2) flags.push('low_holder_concentration');

    let mint: PublicKey;
    let canonical: PublicKey;
    try {
        mint = new PublicKey(mintS);
        canonical = canonicalPoolPda(mint);
    } catch {
        return { status: 'unavailable', risk: 'elevated', score: flags.length, flags, features };
    }
    features.canonical_pool = canonical.toBase58();

    try {
        const quoteVaultAta = ata(WSOL_MINT, canonical, TOKEN);
        const infos = await conn().getMultipleAccountsInfo([canonical, quoteVaultAta]);
        const poolInfo = infos[0];
        if (!poolInfo) {
            features.canonical_pool_alive = false;
        } else {
            features.canonical_pool_alive = true;
            const decoded = decodePool(Buffer.from(poolInfo.data));
            if (decoded) {
                let realSol = 0n;
                const vaultInfo = infos[1];
                if (vaultInfo) {
                    const vd = Buffer.from(vaultInfo.data);
                    if (vd.length >= 65) realSol = BigInt(vd.readBigUInt64LE(64));
                }
                const qeff = realSol + decoded.virtualQuote;
                features.pool_real_sol = Number(realSol) / 1e9;
                features.pool_virtual_quote = Number(decoded.virtualQuote) / 1e9;
                features.pool_real_share_pct =
                    qeff > 0n ? Math.round((Number((realSol * 10000n) / qeff)) / 100) : null;
                features.pool_can_edit = decoded.canEdit;
                features.pool_is_holder = decoded.isHolder;
                features.pool_coin_creator =
                    decoded.coinCreator === SYSTEM.toBase58() ? null : decoded.coinCreator;
                features.pool_creator = decoded.creator;
                if (
                    features.pool_real_share_pct !== null &&
                    features.pool_real_share_pct < REAL_SHARE_MIN
                ) {
                    flags.push('hollow_pool');
                }
                if (decoded.canEdit === 1) flags.push('pool_can_edit');
                if (decoded.isHolder === 1) flags.push('pool_creator_holds_lp');
            }
        }
    } catch {
        return { status: 'unavailable', risk: 'elevated', score: flags.length, flags, features };
    }

    const score = flags.length;
    const risk: DrainAuditResult['risk'] = score >= 3 ? 'high' : score >= 1 ? 'elevated' : 'low';
    return { status: 'ok', risk, score, flags, features };
}
