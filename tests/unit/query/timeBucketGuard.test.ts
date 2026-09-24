/**
 * SEC-17: sqlTimeBucketFromTs interpolates tsExpr and tzParam into SQL text.
 */
import { describe, expect, test } from "bun:test";
import { sqlTimeBucketFromTs } from "../../../query/timeBucket";

describe("sqlTimeBucketFromTs caller guard", () => {
    test("rejects hostile fragments and keeps existing caller shapes", () => {
        expect(() => sqlTimeBucketFromTs("now()); DROP TABLE entities; --", "day", "$1")).toThrow(
            /tsExpr/
        );
        expect(() => sqlTimeBucketFromTs("paid_at", "day", "$1); SELECT pg_sleep(5); --")).toThrow(
            /tzParam/
        );

        const fromQuery = sqlTimeBucketFromTs(
            "NULLIF(g.data->>'paidAt', '')::timestamptz",
            "day",
            "$1"
        );
        expect(fromQuery).toBe(
            "to_char((NULLIF(g.data->>'paidAt', '')::timestamptz - make_interval(mins => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
        );

        const fromReadModel = sqlTimeBucketFromTs('"m3_sales"."paid_at"', "week", "$2");
        expect(fromReadModel).toBe(
            "to_char(date_trunc('week', (\"m3_sales\".\"paid_at\" - make_interval(mins => $2)) AT TIME ZONE 'UTC'), 'YYYY-MM-DD')"
        );

        expect(sqlTimeBucketFromTs("paid_at", "day", "-300")).toContain("mins => -300");
    });
});
