import type { BaseComponent } from "../components/BaseComponent";
import type { ProjectionSqlType } from "../../database/projection/types";

export type ReadModelRefresh = "sync" | "async";

export const M3_WHERE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in"] as const;
export type M3WhereOp = (typeof M3_WHERE_OPS)[number];

export interface ReadModelOptions {
    /** Defaults to the class name. */
    name?: string;
    /** Exactly two component constructors that live on *different* entities. */
    from: Array<new (...args: any[]) => BaseComponent>;
    /** Must match `LeftComp.fkField = RightComp.id` (RightComp.id means the right entity id). */
    join: { on: string };
    /** `sync` = write-through in the save transaction (default). `async` currently aliases sync; outbox is not required. */
    refresh?: ReadModelRefresh;
    rebuildable?: boolean;
}

export interface ParsedJoin {
    leftComponent: string;
    leftField: string;
    rightComponent: string;
}

export interface ReadModelProjectSpec {
    propertyKey: string;
    component: string;
    field: string;
    sqlType: ProjectionSqlType;
    columnName: string;
}

export interface ReadModelDescriptor {
    name: string;
    tableName: string;
    target: Function;
    from: string[];
    join: ParsedJoin;
    refresh: ReadModelRefresh;
    rebuildable: boolean;
    projects: ReadModelProjectSpec[];
    shapeHash: string;
    shapeVersion: number;
}
