// Shared component-row hydrator. Eager loads, reload, get(), and Query
// populate must all coerce @CompData Date fields the same way — a string
// date left on the instance makes a later save() throw.
import type { BaseComponent } from "../components";
import { getMetadataStorage } from "../metadata";

export type ComponentRow = {
    id?: string | null;
    data: unknown;
    /**
     * Type id used to look up @CompData metadata for Date coercion.
     * Falls back to the constructed instance's type id when omitted.
     */
    typeId?: string;
};

function fieldBag(comp: BaseComponent): Record<string, unknown> {
    return comp as unknown as Record<string, unknown>;
}

/**
 * Build a persisted, clean component instance from a database or cache row.
 *
 * Coerces @CompData Date fields from valid ISO strings. Does not attach the
 * instance to an entity — callers use addComponent. Invalid date strings are
 * left as strings so serializableData can still reject them.
 */
export function hydrateComponentRow<T extends BaseComponent>(
    ctor: new () => T,
    row: ComponentRow,
): T {
    const comp = new ctor();
    const raw = row.data;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed != null && typeof parsed === "object") {
        Object.assign(comp, parsed);
    }
    if (row.id) {
        comp.id = row.id;
    }
    const typeId = row.typeId || comp.getTypeID();
    const props = getMetadataStorage().componentProperties.get(typeId);
    if (props) {
        const bag = fieldBag(comp);
        for (const prop of props) {
            if (prop.propertyType !== Date) continue;
            const value = bag[prop.propertyKey];
            if (typeof value !== "string" || value.length === 0) continue;
            const date = new Date(value);
            if (!Number.isNaN(date.getTime())) {
                bag[prop.propertyKey] = date;
            }
        }
    }
    comp.setPersisted(true);
    comp.setDirty(false);
    return comp;
}
