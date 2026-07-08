import db from "../../database";
import { logger } from "../../core/Logger";
import { SurfacePlanner } from "./SurfacePlanner";
import { buildRmQuery, buildRmCountQuery } from "./RmPlanGenerator";
import { recordShadowCompared, recordShadowDivergence } from "./metrics";
import { ProjectionManager } from "../../database/projection/ProjectionManager";
import type { CoverageRequest } from "./CoverageRequest";

const inflight = new Set<Promise<void>>();

export async function drainShadows(): Promise<void> {
    await Promise.allSettled([...inflight]);
}

export function shadowRunExec(req: CoverageRequest, legacyIds: string[]): void {
    const res = SurfacePlanner.instance.resolve(req);
    if (res.surface !== 'rm' || !res.archetype) return;
    const archetype = res.archetype;

    const promise = (async () => {
        try {
            const { sql, params } = buildRmQuery(archetype, req);
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
