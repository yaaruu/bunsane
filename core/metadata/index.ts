import "reflect-metadata";
export {getMetadataStorage} from "./getMetadataStorage";
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