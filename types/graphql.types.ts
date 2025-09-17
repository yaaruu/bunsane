// GraphQL Type Definitions for Bunsane Framework
// This file provides basic type safety for GraphQL resolvers and context

import { Entity } from "../core/Entity";

/**
 * Basic GraphQL Context interface
 * Provides common properties used in resolvers
 * Applications can extend this interface to add their own context properties
 */
export interface GraphQLContext {
    /** The incoming HTTP request */
    request?: Request;
    /** Additional context properties can be added by applications */
    [key: string]: any;
}

/**
 * Simplified GraphQL Info type
 * Represents the GraphQLResolveInfo with minimal properties for type safety
 */
export interface GraphQLInfo {
    /** The field name being resolved */
    fieldName: string;
    /** The field nodes in the selection set */
    fieldNodes: any[];
    /** The return type of the field */
    returnType: any;
    /** The parent type */
    parentType: any;
    /** The schema */
    schema: any;
    /** Fragments defined in the query */
    fragments: any;
    /** Root value */
    rootValue: any;
    /** Operation */
    operation: any;
    /** Variable values */
    variableValues: any;
    /** Path to the current field */
    path: any;
}

/**
 * Utility type for resolver functions
 * Simplifies resolver signatures by hiding complex generics
 */
export type SimpleResolver<TArgs = any, TReturn = any> = (
    args: TArgs,
    context: GraphQLContext,
    info: GraphQLInfo
) => TReturn | Promise<TReturn>;

/**
 * Utility type for field resolvers
 * Provides type safety for parent entity and common parameters
 */
export type FieldResolver<TParent = Entity, TArgs = any, TReturn = any> = (
    parent: TParent,
    args: TArgs,
    context: GraphQLContext,
    info: GraphQLInfo
) => TReturn | Promise<TReturn>;

/**
 * Branded type for better error messages
 */
export type BrandedString<T extends string> = string & { __brand: T };

/**
 * Schema-aware GraphQL operation type
 */
export type SchemaOperation<TInput, TOutput> = {
    type: "Query" | "Mutation";
    input: TInput;
    output: TOutput;
};

/**
 * Type-safe resolver with schema awareness
 */
export type SchemaResolver<TInput, TOutput> = (
    args: TInput,
    context: GraphQLContext,
    info: GraphQLInfo
) => TOutput | Promise<TOutput>;