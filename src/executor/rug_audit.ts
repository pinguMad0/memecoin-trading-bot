// Checks holder concentration, similar-share clusters, identical wallet
// balances, and top-10 ownership. Pool and curve vaults are excluded so
// their unsold tokens are not mistaken for a large private holder.
import { Connection, PublicKey } from '@solana/web3.js';

const ATA_PROG = new PublicKey('ATokenGPvbdgxrpVzKhtMpwXtMVLs7HSKdJD3nd7STXo');
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const PUMP_PROG = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface RugAuditResult {
    pass: boolean;
    reasons: string[];
    supply_raw: string;
    top5_pct: number[];
    top10_pct: number;
    uniform_cluster: number;
    same_balance_cluster: number;
    owners: number;
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

function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
        ATA_PROG,
    )[0];
}

export async function rugAudit(mintS: string, poolS: string): Promise<RugAuditResult> {
    const MAX_TOP = Number(process.env.RUG_MAX_TOP_HOLDER_PCT || 4);
    const MAX_TOP10 = Number(process.env.RUG_MAX_TOP10_PCT || 25);
    const MIN_CLUSTER = Number(process.env.RUG_MIN_CLUSTER_PCT || 1);
    const TOL = Number(process.env.RUG_CLUSTER_TOLERANCE || 0.15);
    const BAL_MIN_SOL = Number(process.env.RUG_SAME_BAL_MIN_SOL || 0.005);

    const empty = (reasons: string[]): RugAuditResult => ({
        pass: false, reasons, supply_raw: '0', top5_pct: [], top10_pct: 0,
        uniform_cluster: 0, same_balance_cluster: 0, owners: 0,
    });

    try {
        const mint = new PublicKey(mintS);
        const pool = new PublicKey(poolS);
        const excluded = new Set<string>([
            pool.toBase58(),
            ata(mint, pool, TOKEN22).toBase58(),
            ata(mint, pool, TOKEN).toBase58(),
            SYSTEM.toBase58(),
        ]);

        const supply = await conn().getTokenSupply(mint);
        const total = BigInt(supply.value.amount);
        if (total === 0n) return empty(['zero-supply']);

        // Read the pool account itself and exclude its ACTUAL vault fields
        // (base@139, quote@171 for pAMM pools). Deriving the vault as an
        // ATA of the pool only works for canonical pools — third-party
        // "flipped" pools (WSOL-base) hold their tokens in vault accounts
        // owned by an external authority, which surfaced as a false
        // "top-holder 78%" (the pool's own unsold supply) on 10-26.
        const poolInfo = await conn().getAccountInfo(pool);
        if (poolInfo) {
            const pd = Buffer.from(poolInfo.data);
            if (pd.length >= 203 &&
                pd.subarray(0, 8).toString('hex') === 'f19a6d0411b16dbc') {
                excluded.add(new PublicKey(pd.subarray(139, 171)).toBase58());
                excluded.add(new PublicKey(pd.subarray(171, 203)).toBase58());
            }
        }
        // Pre-migration signals: exclude the bonding curve and its token
        // account regardless of what the signal's pool field carries.
        const curve = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROG)[0];
        excluded.add(curve.toBase58());
        excluded.add(ata(mint, curve, TOKEN22).toBase58());
        excluded.add(ata(mint, curve, TOKEN).toBase58());

        const largest = await conn().getTokenLargestAccounts(mint);
        const accts = largest.value.slice(0, 20);
        const accInfos = await conn().getMultipleAccountsInfo(accts.map(a => a.address));

        // group by token-account owner, skipping pool-owned vaults
        const byOwner = new Map<string, bigint>();
        accts.forEach((a, i) => {
            const info = accInfos[i];
            if (!info) return;
            const d = Buffer.from(info.data);
            if (d.length < 64) return;
            const owner = new PublicKey(d.subarray(32, 64)).toBase58();
            if (excluded.has(owner) || excluded.has(a.address.toBase58())) return;
            byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(a.amount));
        });
        if (byOwner.size === 0) return empty(['no-holders-readable']);

        const holders = [...byOwner.entries()]
            .map(([owner, amt]) => ({ owner, pct: Number((amt * 10_000n) / total) / 100 }))
            .sort((x, y) => y.pct - x.pct);

        const reasons: string[] = [];

        // 1. top non-pool holder ceiling
        const top = holders[0]?.pct ?? 0;
        if (top > MAX_TOP) reasons.push(`top-holder ${top.toFixed(1)}%`);

        // 2. uniform-share cluster (>=3 owners >=1% within 15% of each other)
        let uniform = 0;
        for (let i = 0; i < holders.length && holders[i].pct >= MIN_CLUSTER; i++) {
            const lo = holders[i].pct * (1 - TOL);
            let k = i;
            while (k + 1 < holders.length && holders[k + 1].pct >= lo
                   && holders[k + 1].pct >= MIN_CLUSTER) k++;
            uniform = Math.max(uniform, k - i + 1);
        }
        if (uniform >= 3) reasons.push(`uniform-cluster ${uniform}`);

        // 3. identical-wallet-balance cluster among the top-10 owners
        const top10 = holders.slice(0, 10);
        const walletInfos = await conn().getMultipleAccountsInfo(
            top10.map(h => new PublicKey(h.owner)),
        );
        const balGroups = new Map<string, number>();
        const balMin = Math.floor(BAL_MIN_SOL * 1e9);
        for (const wi of walletInfos) {
            const lam = wi ? wi.lamports : 0;
            if (lam >= balMin) {
                const key = String(lam);
                balGroups.set(key, (balGroups.get(key) || 0) + 1);
            }
        }
        const balCluster = Math.max(0, ...balGroups.values());
        if (balCluster >= 3) reasons.push(`same-balance ${balCluster}`);

        // 4. top-10 concentration ceiling
        const top10pct = top10.reduce((s, h) => s + h.pct, 0);
        if (top10pct > MAX_TOP10) reasons.push(`top10 ${top10pct.toFixed(1)}%`);

        return {
            pass: reasons.length === 0,
            reasons,
            supply_raw: supply.value.amount,
            top5_pct: holders.slice(0, 5).map(h => Math.round(h.pct * 100) / 100),
            top10_pct: Math.round(top10pct * 100) / 100,
            uniform_cluster: uniform,
            same_balance_cluster: balCluster,
            owners: holders.length,
        };
    } catch (e: any) {
        return empty([`audit-error: ${(e.message || '').slice(0, 80)}`]);
    }
}
