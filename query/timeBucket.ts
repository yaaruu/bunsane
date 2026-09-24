export type TimeTrunc = "day" | "week";

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Identifier, $n, quoted "table"."column", or the Query NULLIF timestamptz cast. */
const TS_EXPR_RE = new RegExp(
    "^(?:" +
        "\\$[1-9][0-9]*" +
        `|${IDENT}(?:\\.${IDENT})?` +
        `|"(?:${IDENT})"\\."(?:${IDENT})"` +
        `|NULLIF\\(${IDENT}\\.data->>'${IDENT}', ''\\)::timestamptz` +
    ")$"
);

/** $n bind, or an integer minutes literal safe inside make_interval(mins => …). */
const TZ_PARAM_RE = /^(?:\$[1-9][0-9]*|-?[0-9]+)$/;

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
    if (!TS_EXPR_RE.test(tsExpr)) {
        throw new Error(
            `sqlTimeBucketFromTs: tsExpr must be an identifier, $param, or known column expression, got ${JSON.stringify(tsExpr)}`
        );
    }
    if (!TZ_PARAM_RE.test(tzParam)) {
        throw new Error(
            `sqlTimeBucketFromTs: tzParam must be a $n parameter or an integer minutes literal, got ${JSON.stringify(tzParam)}`
        );
    }
    const utc = `(${tsExpr} - make_interval(mins => ${tzParam})) AT TIME ZONE 'UTC'`;
    if (trunc === "week") {
        return `to_char(date_trunc('week', ${utc}), 'YYYY-MM-DD')`;
    }
    return `to_char(${utc}, 'YYYY-MM-DD')`;
}
