import { createHash } from 'crypto';
import "reflect-metadata";
import { logger as MainLogger } from "@/core/Logger";
import ComponentRegistry from "./ComponentRegistry";
import { type ComponentDataType } from './Interfaces';
import { uuidv7 } from 'utils/uuid';
import { getMetadataStorage } from '@/core/metadata';
const logger = MainLogger.child({ scope: "Components" });
import BaseComponent from './BaseComponent';

export function generateTypeId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

const primitiveTypes = [String, Number, Boolean, Symbol, BigInt, Date];

export function CompData(options?: { indexed?: boolean; nullable?: boolean; arrayOf?: any }) {
    return (target: any, propertyKey: string) => {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(target.constructor.name);
        const propType = Reflect.getMetadata("design:type", target, propertyKey);
        let isEnum = !!(Reflect.getMetadata("isEnum", propType));
        // console.log(`Property ${propertyKey} type:`, propType?.name);
        // console.log(`Is Enum:`, isEnum);
        let enumValues: string[] | undefined = undefined;
        let enumKeys: string[] | undefined = undefined;
        if(isEnum) {
            const metaEnumValues = Reflect.getMetadata("__enumValues", propType);
            const metaEnumKeys = Reflect.getMetadata("__enumKeys", propType);
            
            if (metaEnumValues && metaEnumKeys) {
                enumValues = metaEnumValues;
                enumKeys = metaEnumKeys;
            } else {
                const staticKeys = Object.getOwnPropertyNames(propType).filter(key => 
                    key !== 'prototype' && 
                    key !== 'length' && 
                    key !== 'name' &&
                    key !== 'isEnum' &&
                    key !== '__enumValues' &&
                    key !== '__enumKeys' &&
                    typeof propType[key] !== 'function' &&
                    typeof propType[key] !== 'boolean'
                );
                if (staticKeys.length > 0) {
                    enumValues = staticKeys.map(key => propType[key]);
                    enumKeys = staticKeys;
                } else {
                    // Fallback for numeric enums
                    enumValues = Object.keys(propType).filter(key => !isNaN(Number(key))).map(key => propType[key]);
                }
            }
        }
        storage.collectComponentPropertyMetadata({
            component_id: typeId,
            propertyKey: propertyKey,
            propertyType: propType,
            indexed: options?.indexed ?? false,
            isPrimitive: primitiveTypes.includes(propType),
            isEnum: isEnum,
            enumValues: enumValues,
            enumKeys: enumKeys,
            isOptional: options?.nullable ?? false,
            arrayOf: options?.arrayOf,
        })
        // Reflect.metadata("compData", { isData: true, indexed: options?.indexed ?? false })(target, propertyKey);
    };
}

export function Component<T extends new () => BaseComponent>(target: T): T {
    const storage = getMetadataStorage();
    const typeId = storage.getComponentId(target.name);
    const properties = storage.getComponentProperties(typeId);
    // console.log(`Component decorator applied to ${target.name} with typeId ${typeId} and properties:`, properties);
    storage.collectComponentMetadata({
        name: target.name,
        typeId: typeId,
        target: target,
    });
    // ComponentRegistry.define(target.name, target);
    return target;
}



export type ComponentGetter<T extends BaseComponent> = Pick<T, "properties" | "id"> & {
    data(): ComponentDataType<T>;
};
