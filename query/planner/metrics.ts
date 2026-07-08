export const qspPlannerMetrics = {
    shadowComparedTotal: 0,
    shadowDivergenceTotal: 0,
    driftTotal: 0,
    lastDivergences: [] as Array<{ archetype: string; kind: string; detail: any; at: string }>,
    routeTotal: {} as Record<string, number>,
    fallbackTotal: {} as Record<string, number>,
};

export function recordShadowCompared() {
    qspPlannerMetrics.shadowComparedTotal++;
}

export function recordShadowDivergence(rec: { archetype: string; kind: string; detail: any }) {
    qspPlannerMetrics.shadowDivergenceTotal++;
    qspPlannerMetrics.lastDivergences.push({ ...rec, at: new Date().toISOString() });
    if (qspPlannerMetrics.lastDivergences.length > 100) qspPlannerMetrics.lastDivergences.shift();
}

export function recordDrift(n = 1) {
    qspPlannerMetrics.driftTotal += n;
}

/** RFC §12: qsp_route_total{archetype} — served path used rm_ for this archetype. */
export function recordRoute(archetype: string) {
    qspPlannerMetrics.routeTotal[archetype] = (qspPlannerMetrics.routeTotal[archetype] ?? 0) + 1;
}

/** RFC §12: qsp_fallback_total{reason} — route attempted but fell through to legacy. */
export function recordFallback(reason: string) {
    qspPlannerMetrics.fallbackTotal[reason] = (qspPlannerMetrics.fallbackTotal[reason] ?? 0) + 1;
}

export function resetQspPlannerMetrics() {
    qspPlannerMetrics.shadowComparedTotal = 0;
    qspPlannerMetrics.shadowDivergenceTotal = 0;
    qspPlannerMetrics.driftTotal = 0;
    qspPlannerMetrics.lastDivergences = [];
    qspPlannerMetrics.routeTotal = {};
    qspPlannerMetrics.fallbackTotal = {};
}
