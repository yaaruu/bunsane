/**
 * k6 load test for the BunSane load-server. Three scenarios run concurrently,
 * each tagged so per-endpoint p95 is reported separately:
 *   - reads:   GET  /load/read     (Query via per-field index)
 *   - updates: POST /load/update   (Entity.save batched-upsert path)
 *   - writes:  POST /load/write    (Entity.save batched-insert path)
 *
 * Run:
 *   k6 run tests/load/k6-load.js
 *   BASE_URL=http://localhost:19900 DURATION=30s VUS=20 k6 run tests/load/k6-load.js
 *
 * A/B the whole-data GIN (toggle between two runs, no restart):
 *   curl "$BASE_URL/load/gin?on=true"   && k6 run tests/load/k6-load.js   # GIN on
 *   curl "$BASE_URL/load/gin?on=false"  && k6 run tests/load/k6-load.js   # GIN off
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:19900";
const DURATION = __ENV.DURATION || "20s";
const VUS = parseInt(__ENV.VUS || "20", 10);

export const options = {
    scenarios: {
        reads: {
            executor: "constant-vus",
            vus: VUS,
            duration: DURATION,
            exec: "readOp",
            tags: { op: "read" },
        },
        updates: {
            executor: "constant-vus",
            vus: Math.max(1, Math.floor(VUS / 2)),
            duration: DURATION,
            exec: "updateOp",
            tags: { op: "update" },
        },
        writes: {
            executor: "constant-vus",
            vus: Math.max(1, Math.floor(VUS / 4)),
            duration: DURATION,
            exec: "writeOp",
            tags: { op: "write" },
        },
    },
    thresholds: {
        http_req_failed: ["rate<0.01"],
        "http_req_duration{op:read}": ["p(95)<150"],
        "http_req_duration{op:update}": ["p(95)<200"],
        "http_req_duration{op:write}": ["p(95)<250"],
    },
};

export function readOp() {
    const res = http.get(`${BASE}/load/read`, { tags: { op: "read" } });
    check(res, { "read 200": (r) => r.status === 200 });
}

export function updateOp() {
    const res = http.post(`${BASE}/load/update`, null, { tags: { op: "update" } });
    check(res, { "update 200": (r) => r.status === 200 });
}

export function writeOp() {
    const res = http.post(`${BASE}/load/write`, null, { tags: { op: "write" } });
    check(res, { "write 200": (r) => r.status === 200 });
}
