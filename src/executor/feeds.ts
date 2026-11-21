// Tails new-pool events and fetches prices for all watched pools in one call.
import * as fs from 'fs';
import { EVENTS_PATH, GT_MULTI } from './config';

export interface PoolEvent {
    mint: string;
    pool: string;
    liq: number;
    buyers: number;
    buys: number;
    sells: number;
}

export class EventTailer {
    private offset: number | null;
    constructor(offset: number | null) {
        this.offset = offset;
    }
    get currentOffset(): number | null {
        return this.offset;
    }
    // Returns new pool events since the last call (byte-offset tail, like the
    // shadow loop; first call snaps to end-of-file so we start fresh).
    readNewPoolEvents(): PoolEvent[] {
        if (!fs.existsSync(EVENTS_PATH)) return [];
        const size = fs.statSync(EVENTS_PATH).size;
        if (this.offset === null) {
            this.offset = size;
            return [];
        }
        if (size <= this.offset) return [];
        const fd = fs.openSync(EVENTS_PATH, 'r');
        const len = size - this.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        fs.closeSync(fd);
        const text = buf.toString('utf8');
        this.offset += Buffer.byteLength(text, 'utf8');
        const out: PoolEvent[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let e: any;
            try { e = JSON.parse(line); } catch { continue; }
            if (e.feed !== 'pool' || !e.mint || !e.pool) continue;
            const mint = String(e.mint).split('solana_').pop() as string;
            if (!e.dex || !String(e.dex).toLowerCase().includes('pump')) continue;
            const liq = Number(e.liq_usd || 0);
            const tx = (((e.payload || {}).attributes || {}).transactions || {}).h1 || {};
            out.push({
                mint,
                pool: e.pool,
                liq,
                buyers: Number(tx.buyers || 0),
                buys: Number(tx.buys || 0),
                sells: Number(tx.sells || 0),
            });
        }
        return out;
    }
}

export async function fetchJson(url: string, init?: RequestInit): Promise<any> {
    const resp = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', ...(init?.headers || {}) },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url.slice(0, 60)}`);
    return resp.json();
}

// One call prices every watched pool (GT multi-pool). Returns pool -> price map.
export async function pollMultiPool(poolAddresses: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!poolAddresses.length) return out;
    const d = await fetchJson(GT_MULTI + poolAddresses.join(','));
    for (const p of d.data || []) {
        const attrs = p.attributes || {};
        const price = Number(attrs.base_token_price_usd);
        if (attrs.address && price > 0) out.set(attrs.address, price);
    }
    return out;
}
