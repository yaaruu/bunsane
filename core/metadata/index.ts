import "reflect-metadata";
import { getMetadataStorage } from "./getMetadataStorage";

export { getMetadataStorage } from "./getMetadataStorage";

function toFieldLabel(fieldName: string): string {
    let label = fieldName.replace(/_/g, ' ');
    label = label.split(' ').map(word => word === 'id' ? 'ID' : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    return label;
}

export function getSerializedMetadataStorage(): {
    archeTypes: Record<
        string,
        {
            fieldName: string;
            componentName: string;
            fieldLabel: string;
            nullable?: boolean;
        }[]
    >;
} {
    const storage = getMetadataStorage();
    const archeTypes: Record<string, any> = {};

    storage.archetypes_field_map.forEach((v, k) => {
        archeTypes[k] = v.map((value) => {
            return {
                fieldName: value.fieldName,
                componentName: value.component.name,
                fieldLabel: toFieldLabel(value.fieldName),
                nullable: value.options?.nullable,
            };
        });
    });

    // console.log(archeTypes, 'archeTypes');

    return {
        archeTypes,
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