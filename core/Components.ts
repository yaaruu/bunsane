import { createHash } from 'crypto';
import "reflect-metadata";
import { logger as MainLogger } from "./Logger";
import ComponentRegistry from "./ComponentRegistry";
import { uuidv7 } from 'utils/uuid';
import { getMetadataStorage } from './metadata';
const logger = MainLogger.child({ scope: "Components" });

export function generateTypeId(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

const primitiveTypes = [String, Number, Boolean, Symbol, BigInt];

//TODO: Continue here
export function CompData(options?: { indexed?: boolean; nullable?: boolean }) {
    return (target: any, propertyKey: string) => {
        const storage = getMetadataStorage();
        const typeId = storage.getComponentId(target.constructor.name);
        const propType = Reflect.getMetadata("design:type", target, propertyKey);
        let isEnum = !!(Reflect.getMetadata("isEnum", propType));
        if (propType.name === 'ServiceType') isEnum = true;
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
        })
        // Reflect.metadata("compData", { isData: true, indexed: options?.indexed ?? false })(target, propertyKey);
    };
}

// TODO: Component Property Casting
// export enum CompCastingType {
//     STRING = "string",
//     NUMBER = "number",
//     BOOLEAN = "boolean",
//     DATE = "date",
// }
// /**
//  * Cast property to specific type when loading from database
//  * @param type Casting type for the property
//  * @returns 
//  */
// export function Cast(type: CompCastingType) {
//     return Reflect.metadata("compCast", { type });
// }

// Type helper to extract only data properties (excludes methods and private properties)
export type ComponentDataType<T extends BaseComponent> = {
    [K in keyof T as T[K] extends Function ? never : 
                    K extends `_${string}` ? never : 
                    K extends 'id' | 'getTypeID' | 'properties' | 'data' | 'save' | 'insert' | 'update' ? never : 
                    K]: T[K];
};

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

export class BaseComponent {
    public id: string = "";
    protected _comp_name: string = "";
    protected _typeId: string = "";
    protected _persisted: boolean = false;
    protected _dirty: boolean = false;

    constructor() {
        this._comp_name = this.constructor.name;
        const storage = getMetadataStorage();
        this._typeId = storage.getComponentId(this._comp_name);
        this._dirty = false;
    }

    getTypeID(): string {
        return this._typeId;
    }

    properties(): string[] {
        const storage = getMetadataStorage();
        const props = storage.componentProperties.get(this._typeId);
        if(!props) return [];
        return props.map(p => p.propertyKey);
        //
        // return Object.keys(this).filter(prop => {
        //     const meta = Reflect.getMetadata("compData", Object.getPrototypeOf(this), prop);
        //     return meta && meta.isData;
        // });
    }

    /**
     * Get data for this component
     * @returns Object containing only properties marked with @CompData decorator
     */
    data<T extends this>(): ComponentDataType<T> {
        const data: Record<string, any> = {};
        this.properties().forEach((prop: string) => {
            data[prop] = (this as any)[prop];
        });
        return data as ComponentDataType<T>;
    }

    async save(trx: Bun.SQL, entity_id: string) {
        logger.trace(`Saving component ${this._comp_name} for entity ${entity_id}`);
        logger.trace(`Checking is Component can be saved (is registered)`);
        await ComponentRegistry.getReadyPromise(this._comp_name);
        logger.trace(`Component Registered`);
        if(this._persisted) {
            await this.update(trx);
        } else {
            await this.insert(trx, entity_id);
            this._persisted = true;
        }
    }

    async insert(trx: Bun.SQL, entity_id: string) {
        if(this.id === "") {
            this.id = uuidv7();
        }
        await trx`INSERT INTO components 
        (id, entity_id, name, type_id, data)
        VALUES (${this.id}, ${entity_id}, ${this._comp_name}, ${this._typeId}, ${this.data()})`
        await trx`INSERT INTO entity_components (entity_id, type_id, component_id) VALUES (${entity_id}, ${this._typeId}, ${this.id}) ON CONFLICT DO NOTHING`
    }

    async update(trx: Bun.SQL) {
        if(this.id === "") {
            throw new Error("Component must have an ID to be updated");
        }
        await trx`UPDATE components SET data = ${this.data()} WHERE id = ${this.id}`
    }

    public setPersisted(persisted: boolean) {
        this._persisted = persisted;
    }

    public setDirty(dirty: boolean) {
        this._dirty = dirty;
    }

    indexedProperties(): string[] {
        const storage = getMetadataStorage();
        const props = storage.componentProperties.get(this._typeId);
        if(!props) return [];
        return props.filter(p => p.indexed).map(p => p.propertyKey);
    }
}

export type ComponentGetter<T extends BaseComponent> = Pick<T, "properties" | "id"> & {
    data(): ComponentDataType<T>;
};
