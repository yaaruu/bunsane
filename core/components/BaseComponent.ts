import { createHash } from 'crypto';
import "reflect-metadata";
import { logger as MainLogger } from "../Logger";
import ComponentRegistry from "./ComponentRegistry";
import { type ComponentDataType } from './Interfaces';
import { uuidv7 } from '../../utils/uuid';
import { getMetadataStorage } from '../metadata';
const logger = MainLogger.child({ scope: "Components" });

// Cached property-name arrays keyed by typeId. Metadata is immutable after
// decorator registration, so allocating once per class is safe.
const _propNamesCache = new Map<string, string[]>();

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
        const cached = _propNamesCache.get(this._typeId);
        if (cached) return cached;
        const storage = getMetadataStorage();
        const props = storage.componentProperties.get(this._typeId);
        const names = Object.freeze(props ? props.map(p => p.propertyKey) : []) as string[];
        _propNamesCache.set(this._typeId, names);
        return names;
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

    /**
     * Get serializable data for database storage
     * @returns Object with Dates serialized to ISO strings
     */
    serializableData(): Record<string, any> {
        const data: Record<string, any> = {};
        const storage = getMetadataStorage();
        const props = storage.componentProperties.get(this._typeId);
        if (!props) return data;
        // Iterate the property metadata directly — avoids the prior O(n²)
        // pattern (properties().forEach + props.find per property) and the
        // redundant second metadata lookup inside properties(). Hot write path:
        // runs for every dirty component on every save.
        for (const propMeta of props) {
            const prop = propMeta.propertyKey;
            let value = (this as any)[prop];
            if (value !== null && value !== undefined) {
                if (propMeta.propertyType === Date) {
                    if (!(value instanceof Date)) {
                        throw new Error(`Type mismatch for property '${prop}' on component '${this._comp_name}': expected Date, got ${typeof value}`);
                    }
                    if (Number.isNaN(value.getTime())) {
                        throw new Error(`Invalid Date for property '${prop}' on component '${this._comp_name}'`);
                    }
                    value = value.toISOString();
                } else if (propMeta.propertyType === Number && typeof value === 'number' && !Number.isFinite(value)) {
                    throw new Error(`Invalid number for property '${prop}' on component '${this._comp_name}': ${value}`);
                }
            }
            data[prop] = value;
        }
        return data;
    }

    async save(trx: Bun.SQL, entity_id: string) {
        // Level-gated: template literal allocates per component save even
        // when trace is disabled.
        if (logger.isLevelEnabled?.('trace')) {
            logger.trace(`Saving component ${this._comp_name} for entity ${entity_id}`);
        }
        // Only check readiness if component is not yet registered
        // This optimization avoids 40,000+ unnecessary async calls for bulk operations
        if(!ComponentRegistry.isComponentReady(this._comp_name)) {
            logger.trace(`Checking is Component can be saved (is registered)`);
            await ComponentRegistry.getReadyPromise(this._comp_name);
            logger.trace(`Component Registered`);
        }
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
        // Validate entity_id to prevent PostgreSQL UUID parsing errors
        if (!entity_id || entity_id.trim() === '') {
            throw new Error(`Cannot insert component ${this._comp_name}: entity_id is empty or invalid`);
        }
        await trx`INSERT INTO components
        (id, entity_id, name, type_id, data)
        VALUES (${this.id}, ${entity_id}, ${this._comp_name}, ${this._typeId}, ${this.serializableData()})`
    }

    async update(trx: Bun.SQL) {
        if(this.id === "") {
            throw new Error("Component must have an ID to be updated");
        }
        await trx`UPDATE components SET data = ${this.serializableData()} WHERE id = ${this.id}`
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

export default BaseComponent;