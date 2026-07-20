import db from "../../database";
import { logger } from "../../core/Logger";
import { SurfacePlanner } from "./SurfacePlanner";
import { buildRmQuery, buildRmCountQuery } from "./RmPlanGenerator";
import { recordShadowCompared, recordShadowDivergence, recordHydrationParity } from "./metrics";
import { ProjectionManager } from "../../database/projection/ProjectionManager";
import { PlannerCache } from "./PlannerCache";
import { resolveHydrationPlan, EMPTY_HYDRATION_PLAN, type RmHydrationPlan } from "./RmHydrationPlan";
import { compareHydrationParity } from "./HydrationParity";
import { qspHydrateShadow } from "../../database/projection/qspConfig";
import type { CoverageRequest } from "./CoverageRequest";

const inflight = new Set<Promise<void>>();

export async function drainShadows(): Promise<void> {
    await Promise.allSettled([...inflight]);
}

/** Hydration columns to fetch for data-parity, or the empty plan when the shadow is off. */
function hydrationShadowPlan(archetype: string): RmHydrationPlan {
    if (!qspHydrateShadow()) return EMPTY_HYDRATION_PLAN;
    const descriptor = ProjectionManager.instance.getDescriptor(archetype);
    if (!descriptor) return EMPTY_HYDRATION_PLAN;
    const fieldState = PlannerCache.instance.getState(archetype)?.fieldState ?? {};
    return resolveHydrationPlan(archetype, descriptor, fieldState);
}

/**
 * Diff rm_-hydrated component fields against the legacy read. Observation only: divergences
 * are counted and logged, never fed to recordShadowSample, and any error is swallowed so the
 * shadow can never affect the served request.
 */
async function runHydrationParity(
    archetype: string,
    plan: RmHydrationPlan,
    rows: any[]
): Promise<void> {
    if (plan.components.size === 0 || rows.length === 0) return;
    try {
        const divergences = await compareHydrationParity(plan, rows);
        recordHydrationParity(archetype, rows.length, divergences.length);
        if (divergences.length > 0) {
            logger.warn(
                {
                    scope: 'qsp.shadow.hydration',
                    archetype,
                    rowsCompared: rows.length,
                    divergenceCount: divergences.length,
                    typeOnlyCount: divergences.filter(d => d.typeOnly).length,
                    sample: divergences.slice(0, 5),
                },
                'QSP hydration data-parity divergence'
            );
        }
    } catch (err) {
        logger.warn({ scope: 'qsp.shadow.hydration', archetype, err }, 'QSP hydration parity error (swallowed)');
    }
}

export function shadowRunExec(req: CoverageRequest, legacyIds: string[]): void {
    const res = SurfacePlanner.instance.resolve(req);
    if (res.surface !== 'rm' || !res.archetype) return;
    const archetype = res.archetype;

    const promise = (async () => {
        try {
            // Under the hydration shadow the SAME query carries the hydration columns, so
            // data-parity costs no extra rm_ round trip.
            const plan = hydrationShadowPlan(archetype);
            const { sql, params } = buildRmQuery(archetype, req, plan.columns);
            const rows: any[] = await db.unsafe(sql, params);
            const rmIds: string[] = rows.map((r: any) => r.entity_id);
            recordShadowCompared();
            if (legacyIds.length !== rmIds.length) {
                const firstDiffIndex = 0;
                const sample = { legacy: legacyIds.slice(0, 3), rm: rmIds.slice(0, 3) };
                recordShadowDivergence({ archetype, kind: 'exec', detail: { legacyLen: legacyIds.length, rmLen: rmIds.length, firstDiffIndex, sample } });
                logger.warn({ scope: 'qsp.shadow', archetype, divergence: { legacyLen: legacyIds.length, rmLen: rmIds.length, firstDiffIndex, sample } }, 'QSP shadow exec divergence');
                await ProjectionManager.instance.recordShadowSample(archetype, true);
                return;
            }
            let firstDiffIndex = -1;
            for (let i = 0; i < legacyIds.length; i++) {
                if (legacyIds[i] !== rmIds[i]) {
                    firstDiffIndex = i;
                    break;
                }
            }
            if (firstDiffIndex !== -1) {
                const sample = { legacy: legacyIds.slice(0, 3), rm: rmIds.slice(0, 3) };
                recordShadowDivergence({ archetype, kind: 'exec', detail: { legacyLen: legacyIds.length, rmLen: rmIds.length, firstDiffIndex, sample } });
                logger.warn({ scope: 'qsp.shadow', archetype, divergence: { legacyLen: legacyIds.length, rmLen: rmIds.length, firstDiffIndex, sample } }, 'QSP shadow exec divergence');
                await ProjectionManager.instance.recordShadowSample(archetype, true);
            } else {
                await ProjectionManager.instance.recordShadowSample(archetype, false);
                // Ids agree, so rows line up with the legacy set and field-level diffs are
                // meaningful. Runs only under its own flag and never touches recordShadowSample.
                await runHydrationParity(archetype, plan, rows);
            }
        } catch (err) {
            logger.warn({ scope: 'qsp.shadow', archetype, err }, 'QSP shadow exec error (swallowed)');
        }
    })();
    inflight.add(promise);
    promise.finally(() => { inflight.delete(promise); });
}

export function shadowRunCount(req: CoverageRequest, legacyCount: number): void {
    const res = SurfacePlanner.instance.resolve(req);
    if (res.surface !== 'rm' || !res.archetype) return;
    const archetype = res.archetype;

    const promise = (async () => {
        try {
            const { sql, params } = buildRmCountQuery(archetype, req);
            const rows: any[] = await db.unsafe(sql, params);
            const rmCount = Number(rows[0]?.count ?? 0);
            recordShadowCompared();
            const diverged = legacyCount !== rmCount;
            if (diverged) {
                recordShadowDivergence({ archetype, kind: 'count', detail: { legacyCount, rmCount } });
                logger.warn({ scope: 'qsp.shadow', archetype, divergence: { legacyCount, rmCount } }, 'QSP shadow count divergence');
            }
            await ProjectionManager.instance.recordShadowSample(archetype, diverged);
        } catch (err) {
            logger.warn({ scope: 'qsp.shadow', archetype, err }, 'QSP shadow count error (swallowed)');
        }
    })();
    inflight.add(promise);
    promise.finally(() => { inflight.delete(promise); });
}
