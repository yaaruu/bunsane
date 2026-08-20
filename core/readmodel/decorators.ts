import type { BaseComponent } from "../components/BaseComponent";
import type { ReadModelOptions } from "./types";
import { pushProject, ReadModelRegistry } from "./ReadModelRegistry";
import { M3Query } from "./query";

/**
 * Dual-purpose, matching RFC §4.3:
 *   @ReadModel({ from, join }) class InvoiceReport { ... }
 *   await ReadModel(InvoiceReport).where("status", "paid").groupBy("region").sum("total")
 */
export function ReadModel(options: ReadModelOptions): ClassDecorator;
export function ReadModel<T extends object>(ctor: new () => T): M3Query;
export function ReadModel(arg: ReadModelOptions | (new () => object)): ClassDecorator | M3Query {
    if (typeof arg === "function") {
        return new M3Query(arg);
    }
    const options = arg;
    return ((target: Function) => {
        ReadModelRegistry.register(target, options);
    }) as ClassDecorator;
}

export function Project(
    component: new (...args: any[]) => BaseComponent,
    field: string
): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        pushProject(target.constructor, {
            propertyKey: String(propertyKey),
            component,
            field,
        });
    };
}
