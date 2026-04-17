/**
 * Remote Communication: CircuitBreaker
 *
 * Three-state breaker: closed -> open -> half-open -> closed.
 *
 * closed: pass through; increment failure count on error; trip to open at N.
 * open:   reject immediately (fail-fast) until reset timeout elapses.
 * half:   one trial call allowed; success -> closed, failure -> open again.
 *
 * Wraps Redis publish operations so a sustained Redis outage does not stall
 * callers waiting for command timeouts on every request.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
    /** Consecutive failures before opening (default 5) */
    threshold?: number;
    /** ms after opening before a half-open trial is allowed (default 30000) */
    resetTimeoutMs?: number;
}

export class CircuitOpenError extends Error {
    public readonly code = "CIRCUIT_OPEN";
    constructor(message = "Circuit breaker is open") {
        super(message);
        this.name = "CircuitOpenError";
    }
}

export class CircuitBreaker {
    private state: CircuitState = "closed";
    private failures = 0;
    private openedAt = 0;
    private threshold: number;
    private resetTimeoutMs: number;

    /** Hooks for metrics. */
    public onTrip?: () => void;
    public onReject?: () => void;

    constructor(config: CircuitBreakerConfig = {}) {
        this.threshold = config.threshold ?? 5;
        this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    }

    getState(): CircuitState {
        // Lazy transition from open -> half-open when reset window elapses.
        if (
            this.state === "open" &&
            Date.now() - this.openedAt >= this.resetTimeoutMs
        ) {
            this.state = "half-open";
        }
        return this.state;
    }

    async exec<T>(fn: () => Promise<T>): Promise<T> {
        const state = this.getState();
        if (state === "open") {
            this.onReject?.();
            throw new CircuitOpenError();
        }

        try {
            const result = await fn();
            this.recordSuccess();
            return result;
        } catch (err) {
            this.recordFailure();
            throw err;
        }
    }

    recordSuccess(): void {
        const current = this.getState();
        if (current === "half-open") {
            this.state = "closed";
        }
        this.failures = 0;
    }

    recordFailure(): void {
        // Force lazy open->half-open transition before deciding what to do.
        const current = this.getState();
        this.failures++;
        if (current === "half-open") {
            // Trial failed — back to open.
            this.state = "open";
            this.openedAt = Date.now();
            this.onTrip?.();
            return;
        }
        if (current === "closed" && this.failures >= this.threshold) {
            this.state = "open";
            this.openedAt = Date.now();
            this.onTrip?.();
        }
    }

    /** Force reset (useful for tests or manual recovery). */
    reset(): void {
        this.state = "closed";
        this.failures = 0;
        this.openedAt = 0;
    }

    getStats() {
        return {
            state: this.getState(),
            failures: this.failures,
            openedAt: this.openedAt,
        };
    }
}
