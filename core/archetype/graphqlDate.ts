import { GraphQLScalarType } from "graphql";

/**
 * Type-only Date scalar for schema emission. GQLoom maps `z.date()` to
 * GraphQLString; the weaver preset redirects those fields here so the SDL
 * says `Date` only when the Zod/CompData type is Date — never by field name.
 *
 * Runtime serialize/parse is the Date resolver installed by
 * ResolverGeneratorVisitor. This instance only needs the name `Date` so
 * printSchema emits `scalar Date`.
 */
export const GraphQLDate = new GraphQLScalarType({
    name: "Date",
    description: "ISO-8601 date-time",
});

export function isZodDateSchema(schema: any): boolean {
    return !!schema && schema?._zod?.def?.type === "date";
}
