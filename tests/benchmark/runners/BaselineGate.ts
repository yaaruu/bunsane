/**
 * Performance regression gate.
 *
 * The benchmark scenarios previously asserted hand-written absolute p95 targets
 * (`targetP95: 100`). That answers "is this fast enough on the machine someone
 * picked the number on", which is not the question a stabilization effort needs.
 * The question is: **did the change I am about to make cost throughput?**
 *
 * So: record a baseline, then compare later runs against it.
 *
 * Three properties make the comparison survive real life:
 *
 *  1. **Gated on the median, not p95.** p95 of 20 iterations is the 19th of 20
 *     sorted samples — effectively the max, and dominated by GC pauses and
 *     Windows' ~15 ms timer granularity on queries that take 2 ms. Measured:
 *     two runs of *identical code* differed by +40 % at p95. The median is
 *     stable enough to judge; p95 is still recorded, for reading, not gating.
 *  2. **Calibration-normalized, with an absolute floor.** Absolute milliseconds
 *     are not portable across machines, CI runners, or a laptop on battery, so
 *     each scenario is compared as `median / calibrationMedian`. A uniformly 2×
 *     slower host yields the same ratios. And because a ratio on
 *     sub-millisecond timings can swing wildly for free, a regression must ALSO
 *     exceed `MIN_ABSOLUTE_DELTA_MS` in raw median terms to count.
 *  3. **Environment-fingerprinted.** The engine (PGlite vs real Postgres), tier,
 *     pool size and framework version are recorded. A comparison across a
 *     different engine is refused outright rather than silently producing
 *     nonsense: PGlite is single-connection, so nothing about pooling or
 *     concurrency measured there transfers to a real server.
 *
 * Usage:
 *   BENCH_BASELINE=write bun run bench:run:md   # record
 *   bun run bench:run:md                        # compare, non-zero exit on regression
 *   BENCH_MARGIN_PCT=15 bun run bench:run:md    # tighten the allowed drift
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkResult } from '../../stress/BenchmarkRunner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(__dirname, '..', 'baseline');

/**
 * Read from package.json rather than an env var: a fingerprint that silently
 * records "unknown" because a variable was not exported is worse than no
 * fingerprint, since the file looks authoritative either way.
 */
function frameworkVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
        return typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * The scenario whose p95 every other scenario is divided by. It must be the
 * cheapest thing in the suite and must not change between releases, or the
 * normalization drifts with it.
 */
export const CALIBRATION_SCENARIO = 'calibration-single-row';

/**
 * Default tolerated regression before the gate fails, in percent of the
 * normalized median.
 *
 * MEASURED, on PGlite/Windows, md tier, comparing identical code against a
 * single-run baseline: worst-case drift 18.2 %, and some scenarios drift
 * *reproducibly* (count-products +14.1 % then +14.2 %; indexed-filter-category
 * −11 % then −9.9 %). Reproducible drift means the baseline capture run itself
 * differs systematically from later runs, which more iterations cannot fix —
 * raising 20 → 80 iterations barely moved it.
 *
 * So this gate is honestly a **coarse** one at 25 %: it catches the class of
 * regression a structural change introduces (an added round trip per query, a
 * lost batch, a serialization point — those are 2× events, not 20 % ones). It
 * cannot adjudicate a 10 % tuning question on this engine.
 *
 * To tighten it, the baseline must become the median of K suite runs rather than
 * one run, and the authoritative numbers must come from real Postgres — PGlite
 * is single-connection, so nothing it reports describes pool behaviour at all.
 * Both are tracked follow-ups, not silently assumed away here.
 */
const DEFAULT_MARGIN_PCT = 25;

/**
 * A regression must also move the raw median by at least this many ms. Without
 * it, a scenario whose median is 0.4 ms can "regress 50 %" by drifting 0.2 ms,
 * which is noise wearing a percentage.
 */
const MIN_ABSOLUTE_DELTA_MS = 0.5;

export interface BaselineEnvironment {
    engine: 'pglite' | 'postgres';
    tier: string;
    poolMax: number;
    bunsaneVersion: string;
    bunVersion: string;
    platform: string;
}

export interface BaselineScenario {
    /** Reported for humans; NOT what the gate compares (too noisy). */
    p95: number;
    median: number;
    /** median divided by the calibration median — the comparable number. */
    normalized: number;
    rowsReturned: number;
}

export interface Baseline {
    capturedAt: string;
    environment: BaselineEnvironment;
    calibrationMedian: number;
    calibrationP95: number;
    scenarios: Record<string, BaselineScenario>;
}

export interface Regression {
    scenario: string;
    baselineNormalized: number;
    currentNormalized: number;
    changePct: number;
    /** Raw median delta in ms, for the absolute-floor check. */
    deltaMs: number;
}

export interface Comparison {
    ok: boolean;
    /** Set when the two runs are not comparable at all. */
    incomparable?: string;
    marginPct: number;
    /** This run's calibration median, so drift in the denominator is visible. */
    currentCalibrationMedian: number;
    regressions: Regression[];
    improvements: Regression[];
    missing: string[];
    added: string[];
}

export function baselinePath(tier: string, engine: string): string {
    return join(BASELINE_DIR, `${tier}-${engine}.json`);
}

export function currentEnvironment(tier: string): BaselineEnvironment {
    return {
        engine: process.env.USE_PGLITE === 'true' ? 'pglite' : 'postgres',
        tier,
        poolMax: parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10),
        bunsaneVersion: frameworkVersion(),
        bunVersion: Bun.version,
        platform: `${process.platform}-${process.arch}`,
    };
}

export function buildBaseline(results: BenchmarkResult[], env: BaselineEnvironment): Baseline | null {
    const calibration = results.find(r => r.name === CALIBRATION_SCENARIO);
    if (!calibration || calibration.timings.median <= 0) return null;

    const calibrationMedian = calibration.timings.median;
    const scenarios: Record<string, BaselineScenario> = {};
    for (const r of results) {
        scenarios[r.name] = {
            p95: round(r.timings.p95),
            median: round(r.timings.median, 3),
            normalized: round(r.timings.median / calibrationMedian, 4),
            rowsReturned: r.rowsReturned,
        };
    }

    return {
        capturedAt: new Date().toISOString(),
        environment: env,
        calibrationMedian: round(calibrationMedian, 3),
        calibrationP95: round(calibration.timings.p95),
        scenarios,
    };
}

export function writeBaseline(tier: string, baseline: Baseline): string {
    if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });
    const path = baselinePath(tier, baseline.environment.engine);
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return path;
}

export function readBaseline(tier: string, engine: string): Baseline | null {
    const path = baselinePath(tier, engine);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    } catch {
        return null;
    }
}

export function marginPct(): number {
    const raw = parseInt(process.env.BENCH_MARGIN_PCT ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MARGIN_PCT;
}

export function compareToBaseline(current: Baseline, baseline: Baseline): Comparison {
    const margin = marginPct();
    const empty: Comparison = {
        ok: true,
        marginPct: margin,
        currentCalibrationMedian: current.calibrationMedian,
        regressions: [],
        improvements: [],
        missing: [],
        added: [],
    };

    // Refuse rather than mislead: PGlite is single-connection and a different
    // planner, so its numbers say nothing about a real server's.
    if (current.environment.engine !== baseline.environment.engine) {
        return { ...empty, ok: false, incomparable: `engine changed: baseline=${baseline.environment.engine} current=${current.environment.engine}` };
    }
    if (current.environment.tier !== baseline.environment.tier) {
        return { ...empty, ok: false, incomparable: `tier changed: baseline=${baseline.environment.tier} current=${current.environment.tier}` };
    }

    const regressions: Regression[] = [];
    const improvements: Regression[] = [];
    const missing: string[] = [];
    const added: string[] = [];

    for (const name of Object.keys(baseline.scenarios)) {
        if (!(name in current.scenarios)) missing.push(name);
    }
    for (const name of Object.keys(current.scenarios)) {
        if (!(name in baseline.scenarios)) added.push(name);
    }

    for (const [name, cur] of Object.entries(current.scenarios)) {
        if (name === CALIBRATION_SCENARIO) continue;
        const base = baseline.scenarios[name];
        if (!base || base.normalized <= 0) continue;

        const changePct = ((cur.normalized - base.normalized) / base.normalized) * 100;
        const deltaMs = cur.median - base.median;
        const entry: Regression = {
            scenario: name,
            baselineNormalized: base.normalized,
            currentNormalized: cur.normalized,
            changePct: round(changePct, 1),
            deltaMs: round(deltaMs, 3),
        };
        // The ratio and the raw median must agree in SIGN as well as size.
        // Without the sign check, a run whose calibration median drifted down
        // inflates every ratio, and a scenario that actually got FASTER in raw
        // ms gets reported as a regression (observed: +4.2% ratio, -1.28 ms raw).
        if (changePct > margin && deltaMs >= MIN_ABSOLUTE_DELTA_MS) regressions.push(entry);
        else if (changePct < -margin && deltaMs <= -MIN_ABSOLUTE_DELTA_MS) improvements.push(entry);
    }

    regressions.sort((a, b) => b.changePct - a.changePct);
    return {
        ok: regressions.length === 0,
        marginPct: margin,
        currentCalibrationMedian: current.calibrationMedian,
        regressions,
        improvements,
        missing,
        added,
    };
}

export function formatComparison(c: Comparison, baseline: Baseline): string {
    const lines: string[] = [];
    if (c.incomparable) {
        return `\n[bench-gate] NOT COMPARABLE — ${c.incomparable}\n` +
            `[bench-gate] Capture a baseline for this environment: BENCH_BASELINE=write\n`;
    }

    lines.push('');
    lines.push(`[bench-gate] baseline ${baseline.capturedAt} (${baseline.environment.engine}, tier ${baseline.environment.tier}, bunsane ${baseline.environment.bunsaneVersion})`);
    lines.push(
        `[bench-gate] comparing calibration-normalized MEDIAN, margin ±${c.marginPct}% ` +
        `and ≥${MIN_ABSOLUTE_DELTA_MS}ms raw (calibration median ` +
        `${baseline.calibrationMedian}ms → ${c.currentCalibrationMedian}ms)`,
    );

    if (c.regressions.length === 0) lines.push('[bench-gate] no regressions');
    for (const r of c.regressions) {
        lines.push(`[bench-gate] REGRESSION ${r.scenario}: ${r.baselineNormalized} → ${r.currentNormalized} (+${r.changePct}%, ${r.deltaMs >= 0 ? '+' : ''}${r.deltaMs}ms)`);
    }
    for (const r of c.improvements) {
        lines.push(`[bench-gate] improved   ${r.scenario}: ${r.baselineNormalized} → ${r.currentNormalized} (${r.changePct}%, ${r.deltaMs}ms)`);
    }
    if (c.missing.length) lines.push(`[bench-gate] scenarios missing from this run (not judged): ${c.missing.join(', ')}`);
    if (c.added.length) lines.push(`[bench-gate] new scenarios (no baseline yet): ${c.added.join(', ')}`);
    lines.push('');
    return lines.join('\n');
}

function round(value: number, places = 2): number {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}
