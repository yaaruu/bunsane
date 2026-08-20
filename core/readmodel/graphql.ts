import { ReadModelRegistry } from "./ReadModelRegistry";
import { M3Query, clampReadModelListLimit } from "./query";
import type { M3WhereOp } from "./types";
import type { ReadModelDescriptor, ReadModelProjectSpec } from "./types";

function gqlScalar(sqlType: string): string {
    if (sqlType === "numeric") return "Float";
    if (sqlType === "boolean") return "Boolean";
    if (sqlType === "timestamptz") return "Date";
    return "String";
}

function typeName(d: ReadModelDescriptor): string {
    return d.name;
}

function aggTypeName(d: ReadModelDescriptor): string {
    return `${d.name}Aggregate`;
}

function lcFirst(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function listField(d: ReadModelDescriptor): string {
    return `${lcFirst(d.name)}s`;
}

function countField(d: ReadModelDescriptor): string {
    return `${lcFirst(d.name)}Count`;
}

function sumField(d: ReadModelDescriptor): string {
    return `${lcFirst(d.name)}Sum`;
}

function avgField(d: ReadModelDescriptor): string {
    return `${lcFirst(d.name)}Avg`;
}

function numerics(d: ReadModelDescriptor): ReadModelProjectSpec[] {
    return d.projects.filter((p) => p.sqlType === "numeric");
}

function groupables(d: ReadModelDescriptor): ReadModelProjectSpec[] {
    return d.projects.filter((p) => p.sqlType !== "numeric");
}

function usesDateScalar(): boolean {
    return ReadModelRegistry.all().some((d) => d.projects.some((p) => p.sqlType === "timestamptz"));
}

/**
 * SDL for registered read models. Query fields only — mutationFields is always empty.
 * Used by SchemaGeneratorVisitor and by tests that inspect the shipped surface.
 */
export function readModelTypeDefs(): string {
    const models = ReadModelRegistry.all();
    if (models.length === 0) return "";
    let out = "\n# M3 read models (derived, read-only — no mutations)\n";
    out += `input ReadModelWhere {
  field: String!
  op: String = "eq"
  value: String
  values: [String!]
}
`;
    for (const d of models) {
        const fields = d.projects
            .map((p) => `  ${p.propertyKey}: ${gqlScalar(p.sqlType)}`)
            .join("\n");
        out += `type ${typeName(d)} {\n  leftEntityId: ID!\n  rightEntityId: ID\n${fields}\n}\n`;
        const numeric = numerics(d);
        if (numeric.length > 0) {
            const aggFields = [
                ...groupables(d).map((p) => `  ${p.propertyKey}: ${gqlScalar(p.sqlType)}`),
                ...numeric.map((p) => `  ${p.propertyKey}: Float`),
            ].join("\n");
            out += `type ${aggTypeName(d)} {\n${aggFields}\n}\n`;
        }
    }
    return out;
}

export function readModelQueryFields(): string[] {
    const fields: string[] = [];
    for (const d of ReadModelRegistry.all()) {
        const t = typeName(d);
        fields.push(`${listField(d)}(where: [ReadModelWhere!], limit: Int): [${t}!]!`);
        fields.push(`${countField(d)}(where: [ReadModelWhere!]): Int!`);
        if (numerics(d).length > 0) {
            const agg = aggTypeName(d);
            fields.push(
                `${sumField(d)}(metric: String, groupBy: String, where: [ReadModelWhere!]): [${agg}!]!`
            );
            fields.push(
                `${avgField(d)}(metric: String, groupBy: String, where: [ReadModelWhere!]): [${agg}!]!`
            );
        }
    }
    return fields;
}

/** Always empty — derived tables are not a write API. */
export function readModelMutationFields(): string[] {
    return [];
}

export function buildReadModelGraphQLSDL(): string {
    const types = readModelTypeDefs();
    const queries = readModelQueryFields();
    const mutations = readModelMutationFields();
    let sdl = usesDateScalar() ? "scalar Date\n" : "";
    sdl += types;
    if (queries.length > 0) {
        sdl += `type Query {\n${queries.map((f) => `  ${f}`).join("\n")}\n}\n`;
    }
    if (mutations.length > 0) {
        sdl += `type Mutation {\n${mutations.map((f) => `  ${f}`).join("\n")}\n}\n`;
    }
    return sdl;
}

interface GqlWhere {
    field?: string;
    op?: string;
    value?: string | null;
    values?: string[] | null;
}

function applyGqlWhere(q: M3Query, where: GqlWhere[] | undefined): void {
    if (!where) return;
    for (const pred of where) {
        if (!pred.field) {
            throw new Error("ReadModelWhere.field is required");
        }
        const op = String(pred.op ?? "eq").toLowerCase() as M3WhereOp;
        if (op === "in") {
            q.whereIn(pred.field, pred.values ?? []);
        } else {
            if (pred.value === undefined || pred.value === null) {
                throw new Error(`ReadModelWhere '${pred.field}' requires value`);
            }
            q.where(pred.field, op, pred.value);
        }
    }
}

function wrapAggregate(
    result: number | Array<Record<string, unknown>>,
    metricKey: string
): Array<Record<string, unknown>> {
    if (Array.isArray(result)) return result;
    return [{ [metricKey]: result }];
}

/**
 * Live Query resolvers. Wired by ResolverGeneratorVisitor so injected SDL is not a stub.
 */
export function readModelResolvers(): { Query: Record<string, Function> } {
    const Query: Record<string, Function> = {};
    for (const d of ReadModelRegistry.all()) {
        Query[listField(d)] = async (_parent: unknown, args: { where?: GqlWhere[]; limit?: number }) => {
            const q = new M3Query(d.target);
            applyGqlWhere(q, args.where);
            q.limit(clampReadModelListLimit(args.limit));
            return q.rows();
        };
        Query[countField(d)] = async (_parent: unknown, args: { where?: GqlWhere[] }) => {
            const q = new M3Query(d.target);
            applyGqlWhere(q, args.where);
            return q.count();
        };
        const numeric = numerics(d);
        const firstNumeric = numeric[0];
        if (firstNumeric) {
            const defaultMetric = firstNumeric.propertyKey;
            Query[sumField(d)] = async (
                _parent: unknown,
                args: { metric?: string; groupBy?: string; where?: GqlWhere[] }
            ) => {
                const metric = args.metric ?? defaultMetric;
                const q = new M3Query(d.target);
                applyGqlWhere(q, args.where);
                if (args.groupBy) q.groupBy(args.groupBy);
                return wrapAggregate(await q.sum(metric), metric);
            };
            Query[avgField(d)] = async (
                _parent: unknown,
                args: { metric?: string; groupBy?: string; where?: GqlWhere[] }
            ) => {
                const metric = args.metric ?? defaultMetric;
                const q = new M3Query(d.target);
                applyGqlWhere(q, args.where);
                if (args.groupBy) q.groupBy(args.groupBy);
                return wrapAggregate(await q.avg(metric), metric);
            };
        }
    }
    return { Query };
}
