import "reflect-metadata";
import { getMetadataStorage } from "./getMetadataStorage";

export { getMetadataStorage } from "./getMetadataStorage";

export function getSerializedMetadataStorage() {
    const storage = getMetadataStorage();
    return {
        components: storage.components.map((c) => ({
            name: c.name,
            options: c.options,
        })),
        archetypes: storage.archetypes.map((a) => ({
            name: a.name,
            options: a.options,
        })),
        indexedFields: Object.fromEntries(storage.indexedFields),
        componentProperties: Object.fromEntries(storage.componentProperties),
    };
}

export function Enum() {
    return (target: any) => {
        Reflect.defineMetadata("isEnum", true, target);
        const staticKeys = Object.getOwnPropertyNames(target).filter(key => 
            key !== 'prototype' && 
            key !== 'length' && 
            key !== 'name' && 
            typeof target[key] !== 'function'
        );
        if (staticKeys.length > 0) {
            Reflect.defineMetadata("__enumValues", staticKeys.map(key => target[key]), target);
            Reflect.defineMetadata("__enumKeys", staticKeys, target);
        }
    };
}