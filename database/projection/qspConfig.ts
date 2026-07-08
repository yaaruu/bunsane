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

export function qspCountStrategy(): 'exact' | 'estimate' | 'n_plus_1' {
    const v = process.env.BUNSANE_QSP_COUNT;
    return v === 'estimate' || v === 'n_plus_1' ? v : 'exact';
}
