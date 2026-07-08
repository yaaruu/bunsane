export type { CoverageRequest, CoverageFilter, CoverageSort, CoverageCursor, CoverageOp } from "./CoverageRequest";
export { buildCoverageRequest } from "./CoverageSet";
export { SurfacePlanner, type PlanResolution } from "./SurfacePlanner";
export { buildRmQuery, buildRmCountQuery, buildRmEstimateQuery } from "./RmPlanGenerator";
export { PlannerCache } from "./PlannerCache";
export { shadowRunExec, shadowRunCount, drainShadows } from "./ShadowRunner";
export {
    qspPlannerMetrics,
    recordShadowCompared,
    recordShadowDivergence,
    recordDrift,
    recordRoute,
    recordFallback,
    resetQspPlannerMetrics,
} from "./metrics";
