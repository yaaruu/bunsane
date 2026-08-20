export type TimeTrunc = "day" | "week";

/**
 * Local calendar key matching Isoiresik `bucketKeyFor(new Date(ms - tzMs), …)`:
 * shift the instant by `tzOffsetMinutes`, then take the UTC Y-M-D (week = Monday).
 * `to_char(timestamptz, …)` is session-TimeZone-dependent — always AT TIME ZONE 'UTC'.
 */
export function sqlTimeBucketFromTs(
    tsExpr: string,
    trunc: TimeTrunc,
    tzParam: string
): string {
    const utc = `(${tsExpr} - make_interval(mins => ${tzParam})) AT TIME ZONE 'UTC'`;
    if (trunc === "week") {
        return `to_char(date_trunc('week', ${utc}), 'YYYY-MM-DD')`;
    }
    return `to_char(${utc}, 'YYYY-MM-DD')`;
}
