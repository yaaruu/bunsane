import { createHash } from "crypto";
import { getMetadataStorage } from "../metadata";
import { assertIdentifier } from "../../query/SqlIdentifier";
import type { ProjectionSqlType } from "../../database/projection/types";
import { parseJoinOn, m3TableName, assertM3TableName } from "./join";
import type { ReadModelDescriptor, ReadModelOptions, ReadModelProjectSpec } from "./types";

const PROJECTS_KEY = Symbol.for("bunsane:readmodel:projects");

export interface PendingProject {
    propertyKey: string;
    component: Function;
    field: string;
}

export function pushProject(ctor: Function, spec: PendingProject): void {
    const list: PendingProject[] = Reflect.getOwnMetadata(PROJECTS_KEY, ctor) ?? [];
    list.push(spec);
    Reflect.defineMetadata(PROJECTS_KEY, list, ctor);
}

export function readProjects(ctor: Function): PendingProject[] {
    return (Reflect.getOwnMetadata(PROJECTS_KEY, ctor) ?? []) as PendingProject[];
}

function sqlTypeOf(componentName: string, field: string): ProjectionSqlType {
    const storage = getMetadataStorage();
    const typeId = storage.getComponentId(componentName);
    const props = storage.getComponentProperties(typeId);
    const prop = props.find((p) => p.propertyKey === field);
    const t = prop?.propertyType;
    if (t === Number) return "numeric";
    if (t === Boolean) return "boolean";
    if (t === Date) return "timestamptz";
    return "text";
}

function computeHash(desc: Omit<ReadModelDescriptor, "shapeHash" | "shapeVersion">): string {
    const canonical = [
        desc.name,
        desc.join.leftComponent,
        desc.join.leftField,
        desc.join.rightComponent,
        ...desc.projects
            .map((p) => `${p.component}:${p.field}:${p.sqlType}:${p.columnName}`)
            .sort(),
    ].join("|");
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

class Registry {
    private byCtor = new Map<Function, ReadModelDescriptor>();
    private byName = new Map<string, ReadModelDescriptor>();

    register(ctor: Function, options: ReadModelOptions): ReadModelDescriptor {
        if (!options.from || options.from.length !== 2) {
            throw new Error(`@ReadModel '${ctor.name}' requires from: [LeftComponent, RightComponent] (exactly two)`);
        }
        const join = parseJoinOn(options.join.on);
        const fromNames = options.from.map((c) => c.name);
        if (!fromNames.includes(join.leftComponent) || !fromNames.includes(join.rightComponent)) {
            throw new Error(
                `@ReadModel '${ctor.name}' join components must be listed in from[] (join=${join.leftComponent}/${join.rightComponent}, from=${fromNames.join(",")})`
            );
        }
        const name = assertIdentifier(options.name ?? ctor.name, "ReadModel.name");
        const pending = readProjects(ctor);
        if (pending.length === 0) {
            throw new Error(`@ReadModel '${name}' has no @Project fields`);
        }
        const projects: ReadModelProjectSpec[] = pending.map((p) => {
            const component = p.component.name;
            const field = assertIdentifier(p.field, "ReadModel.project.field");
            const propertyKey = assertIdentifier(p.propertyKey, "ReadModel.project.property");
            if (component !== join.leftComponent && component !== join.rightComponent) {
                throw new Error(`@Project ${component}.${field} is not in the join (${join.leftComponent} ⋈ ${join.rightComponent})`);
            }
            return {
                propertyKey,
                component,
                field,
                sqlType: sqlTypeOf(component, field),
                columnName: propertyKey,
            };
        });
        const draft = {
            name,
            tableName: assertM3TableName(m3TableName(name)),
            target: ctor,
            from: fromNames,
            join,
            refresh: options.refresh ?? "sync",
            rebuildable: options.rebuildable !== false,
            projects,
        };
        const descriptor: ReadModelDescriptor = {
            ...draft,
            shapeHash: computeHash(draft),
            shapeVersion: 1,
        };
        this.byCtor.set(ctor, descriptor);
        this.byName.set(name, descriptor);
        return descriptor;
    }

    getByCtor(ctor: Function): ReadModelDescriptor | undefined {
        return this.byCtor.get(ctor);
    }

    getByName(name: string): ReadModelDescriptor | undefined {
        return this.byName.get(name);
    }

    requireByCtor(ctor: Function): ReadModelDescriptor {
        const d = this.byCtor.get(ctor);
        if (!d) throw new Error(`No @ReadModel registered for ${ctor.name}`);
        return d;
    }

    all(): ReadModelDescriptor[] {
        return Array.from(this.byName.values());
    }

    reset(): void {
        this.byCtor.clear();
        this.byName.clear();
    }
}

export const ReadModelRegistry = new Registry();
