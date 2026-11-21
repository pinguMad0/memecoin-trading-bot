// Executor entry point.
//
// Paper mode (default, LIVE=false):
//   node node_modules/ts-node/dist/bin.js src/executor_entry.ts [--duration 120] [--quiet]
//
// Selftest (read-only Jupiter quote reachability check, no wallet needed):
//   node node_modules/ts-node/dist/bin.js src/executor_entry.ts --selftest
//
// LIVE mode (triple gate: LIVE=true in .env + PRIVATE_KEY set + --confirm-live):
//   node node_modules/ts-node/dist/bin.js src/executor_entry.ts --confirm-live
//
// Fail-closed: any missing gate drops to paper mode and says why.
import * as dotenv from 'dotenv';
dotenv.config();

import { loadExecutorConfig } from './executor/config';
import { LiveBroker } from './executor/live_broker';
import { PumpSwapBroker } from './executor/pumpswap_broker';
import { ExecutorRunner, Broker } from './executor/runner';

function parseArgs(): { duration: number; quiet: boolean; selftest: boolean; confirmLive: boolean } {
    const args = { duration: 0, quiet: false, selftest: false, confirmLive: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--duration') args.duration = Number(argv[++i] || 0);
        else if (argv[i] === '--quiet') args.quiet = true;
        else if (argv[i] === '--selftest') args.selftest = true;
        else if (argv[i] === '--confirm-live') args.confirmLive = true;
    }
    return args;
}

async function main(): Promise<void> {
    const args = parseArgs();
    const ecfg = loadExecutorConfig(args.confirmLive);
    // EXEC_BROKER=pumpswap -> direct pAMM engine (no Jupiter, no Jito).
    // Default (unset/anything else) -> the original Jupiter+Jito path.
    const usePumpSwap = (process.env.EXEC_BROKER || '').toLowerCase() === 'pumpswap';
    const broker: Broker = usePumpSwap
        ? new PumpSwapBroker(ecfg.live, ecfg.privateKey, process.env.HELIUS_RPC_URL || null)
        : new LiveBroker(ecfg.live, ecfg.privateKey, process.env.HELIUS_RPC_URL || null);
    console.error(`broker: ${usePumpSwap ? 'PumpSwap direct (pAMM v2, plain RPC)' : 'Jupiter+Jito'}`);

    if (args.selftest) {
        console.error('selftest: read-only reachability check (no wallet action)...');
        // The pumpswap broker quotes pools locally, so probe a known graduated
        // pump token; the Jupiter path probes the SOL->USDC route as before.
        const PROBE_MINT = usePumpSwap
            ? process.env.SELFTEST_MINT || 'gdxYdm4429JBfBMLfwyAc9mbaQkj456gxKZdqsEpump'
            : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
        const q = await broker.quoteBuy(PROBE_MINT, 0.01, 300).catch(() => null);
        console.error(q ? `selftest OK: quote received, outAmount=${q.outAmountRaw}` :
            `selftest FAILED: ${broker.lastError}`);
        process.exit(q ? 0 : 1);
    }

    const runner = new ExecutorRunner(ecfg, broker, args.quiet);
    await runner.run(args.duration);
}

main().catch((e) => {
    console.error('executor crashed:', e);
    process.exit(1);
});
