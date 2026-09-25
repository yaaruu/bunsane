import { getMetadataStorage } from "../metadata";

/**
 * Key index over several fields of one component, in order, then `entity_id`:
 *
 * ```ts
 * @CompositeIndex<Order>(["status", "total"])
 * @Component
 * class Order extends BaseComponent { … }
 * ```
 *
 * Serves equality on the leading fields plus sort/range/keyset on the next one
 * (e.g. `status = 'paid'` sorted by `total`, either direction). Fields are
 * checked against the component's `@CompData` properties when indexes are
 * reconciled at boot; an unknown field fails boot.
 *
 * The type argument is optional and only narrows `fields` to that component's keys.
 */
export function CompositeIndex<T = never>(
    fields: readonly ([T] extends [never] ? string : Extract<keyof T, string>)[],
): (target: abstract new (...args: never[]) => unknown) => void {
    if (fields.length < 2) {
        throw new Error("@CompositeIndex needs at least two fields; use @CompData({ indexed: true }) for one.");
    }
    return (target) => {
        const storage = getMetadataStorage();
        storage.collectCompositeIndex({
            componentId: storage.getComponentId(target.name),
            fields: [...fields],
        });
    };
}
