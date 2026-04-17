import { describe, test, expect } from "bun:test";
import {
    CircuitBreaker,
    CircuitOpenError,
} from "../../../core/remote/CircuitBreaker";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CircuitBreaker", () => {
    describe("state transitions", () => {
        test("starts closed", () => {
            const cb = new CircuitBreaker();
            expect(cb.getState()).toBe("closed");
        });

        test("stays closed below threshold", () => {
            const cb = new CircuitBreaker({ threshold: 3 });
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.getState()).toBe("closed");
        });

        test("opens at threshold", () => {
            const cb = new CircuitBreaker({ threshold: 3 });
            cb.recordFailure();
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.getState()).toBe("open");
        });

        test("transitions to half-open after reset window", async () => {
            const cb = new CircuitBreaker({ threshold: 1, resetTimeoutMs: 50 });
            cb.recordFailure();
            expect(cb.getState()).toBe("open");
            await sleep(60);
            expect(cb.getState()).toBe("half-open");
        });

        test("half-open success closes breaker", async () => {
            const cb = new CircuitBreaker({ threshold: 1, resetTimeoutMs: 50 });
            cb.recordFailure();
            await sleep(60);
            expect(cb.getState()).toBe("half-open");
            cb.recordSuccess();
            expect(cb.getState()).toBe("closed");
        });

        test("half-open failure reopens breaker", async () => {
            const cb = new CircuitBreaker({ threshold: 1, resetTimeoutMs: 50 });
            cb.recordFailure();
            await sleep(60);
            expect(cb.getState()).toBe("half-open");
            cb.recordFailure();
            expect(cb.getState()).toBe("open");
        });

        test("success in closed state zeroes failure count", () => {
            const cb = new CircuitBreaker({ threshold: 3 });
            cb.recordFailure();
            cb.recordFailure();
            cb.recordSuccess();
            cb.recordFailure();
            cb.recordFailure();
            // Still closed — counter reset to 0 on success, only 2 new failures
            expect(cb.getState()).toBe("closed");
        });
    });

    describe("exec()", () => {
        test("passes result on success", async () => {
            const cb = new CircuitBreaker();
            const result = await cb.exec(async () => 42);
            expect(result).toBe(42);
        });

        test("records failure on thrown error", async () => {
            const cb = new CircuitBreaker({ threshold: 2 });
            await expect(
                cb.exec(async () => {
                    throw new Error("boom");
                })
            ).rejects.toThrow("boom");
            expect(cb.getStats().failures).toBe(1);
        });

        test("rejects immediately when open", async () => {
            const cb = new CircuitBreaker({ threshold: 1 });
            await expect(
                cb.exec(async () => {
                    throw new Error("fail");
                })
            ).rejects.toThrow();
            // Now open
            await expect(cb.exec(async () => "should not run")).rejects.toBeInstanceOf(
                CircuitOpenError
            );
        });

        test("open-state rejection does not call fn", async () => {
            const cb = new CircuitBreaker({ threshold: 1 });
            await cb.exec(async () => { throw new Error("x"); }).catch(() => {});
            let called = false;
            await cb.exec(async () => { called = true; }).catch(() => {});
            expect(called).toBe(false);
        });
    });

    describe("hooks", () => {
        test("onTrip fires once when opening", () => {
            const cb = new CircuitBreaker({ threshold: 2 });
            let trips = 0;
            cb.onTrip = () => trips++;
            cb.recordFailure();
            expect(trips).toBe(0);
            cb.recordFailure();
            expect(trips).toBe(1);
        });

        test("onTrip fires again on half-open→open transition", async () => {
            const cb = new CircuitBreaker({ threshold: 1, resetTimeoutMs: 30 });
            let trips = 0;
            cb.onTrip = () => trips++;
            cb.recordFailure();
            expect(trips).toBe(1);
            await sleep(40);
            // half-open trial fails
            cb.recordFailure();
            expect(trips).toBe(2);
        });

        test("onReject fires when exec rejected by open breaker", async () => {
            const cb = new CircuitBreaker({ threshold: 1 });
            let rejects = 0;
            cb.onReject = () => rejects++;
            await cb.exec(async () => { throw new Error("x"); }).catch(() => {});
            await cb.exec(async () => 1).catch(() => {});
            expect(rejects).toBe(1);
        });
    });

    describe("reset()", () => {
        test("force-closes an open breaker", () => {
            const cb = new CircuitBreaker({ threshold: 1 });
            cb.recordFailure();
            expect(cb.getState()).toBe("open");
            cb.reset();
            expect(cb.getState()).toBe("closed");
            expect(cb.getStats().failures).toBe(0);
        });
    });

    describe("CircuitOpenError", () => {
        test("has CIRCUIT_OPEN code", () => {
            const err = new CircuitOpenError();
            expect(err.code).toBe("CIRCUIT_OPEN");
            expect(err).toBeInstanceOf(Error);
        });
    });
});
