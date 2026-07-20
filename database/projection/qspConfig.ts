export type QspMode = 'off' | 'shadow' | 'route';

/** Read at CALL time (never at module load) so tests / canaries can flip BUNSANE_QSP at runtime. */
export function qspMode(): QspMode {
    const v = process.env.BUNSANE_QSP;
    return v === 'route' ? 'route' : v === 'shadow' ? 'shadow' : 'off';
}

export function qspActive(): boolean {
    return qspMode() !== 'off';
}

export function qspInScope(archetype: string): boolean {
    const raw = (process.env.BUNSANE_QSP_ARCHETYPES || '').trim();
    if (!raw) return true;
    return raw.split(',').map(s => s.trim()).filter(Boolean).includes(archetype);
}

/**
 * Serve component data from the rm_ row instead of re-reading `components`.
 * Read at CALL time so it can be flipped at runtime. Default off.
 */
export function qspHydrate(): boolean {
    return process.env.BUNSANE_QSP_HYDRATE === 'on';
}

/**
 * Row-hydration data-parity shadow. Independent of BUNSANE_QSP_HYDRATE: this only OBSERVES,
 * diffing rm_-hydrated components against the legacy read without serving either. Its results
 * deliberately do NOT feed recordShadowSample — that drives auto-promotion to READY, and
 * entangling id-parity with data-parity would let one signal promote on the other's evidence.
 */
export function qspHydrateShadow(): boolean {
    return process.env.BUNSANE_QSP_HYDRATE_SHADOW === 'on';
}

export function qspCountStrategy(): 'exact' | 'estimate' | 'n_plus_1' {
    const v = process.env.BUNSANE_QSP_COUNT;
    return v === 'estimate' || v === 'n_plus_1' ? v : 'exact';
}
