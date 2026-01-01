import { logger as MainLogger } from "core/Logger";
import type { GraphQLType } from "./helpers";
import BaseArcheType from "../core/ArcheType";
import type { BaseService } from "service";

const logger = MainLogger.child({ scope: "GraphQLGenerator" });

export interface GraphQLObjectTypeMeta {
    name: string;
    fields: Record<string, GraphQLType>;
}

export interface GraphQLOperationMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
    type: "Query" | "Mutation";
    propertyKey?: string;
    name?: string;
    input?: Record<string, GraphQLType> | any;
    output: GraphQLType | Record<string, GraphQLType> | T;
}

export interface GraphQLSubscriptionMeta<T extends BaseArcheType | BaseArcheType[] | string = string> {
    propertyKey?: string;
    name?: string;
    input?: Record<string, GraphQLType> | any;
    output: GraphQLType | Record<string, GraphQLType> | T;
}

export interface GraphQLFieldMeta {
    type: GraphQLType;
    field: string;
}


export function GraphQLObjectType(meta: GraphQLObjectTypeMeta) {
    return (target: BaseService) => {
        if (!target.__graphqlObjectType) target.__graphqlObjectType = [];
        target.__graphqlObjectType.push(meta);
    }
}

export function GraphQLScalarType(name: string) {
    return (target: any) => {
        if (!target.__graphqlScalarTypes) target.__graphqlScalarTypes = [];
        target.__graphqlScalarTypes.push(name);
    }
}

export function GraphQLOperation<T extends BaseArcheType | BaseArcheType[] | string = string>(meta: GraphQLOperationMeta<T>) {
    return function (target: BaseService, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlOperations) target.__graphqlOperations = [];
        const operationName = meta.name ?? propertyKey;
        if (!operationName) {
            throw new Error("GraphQLOperation: Operation name is required (either meta.name or propertyKey must be defined)");
        }
        const operationMeta = { ...meta, name: operationName, propertyKey } as GraphQLOperationMeta<any>;
        target.__graphqlOperations.push(operationMeta);
    };
}

/**
 * @deprecated Use ArcheTypeFunction instead
 * @param meta 
 * @returns 
 */
export function GraphQLField(meta: GraphQLFieldMeta) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlFields) target.__graphqlFields = [];
        target.__graphqlFields.push({ ...meta, propertyKey });
    };
}


export function GraphQLSubscription<T extends BaseArcheType | BaseArcheType[] | string = string>(meta: GraphQLSubscriptionMeta<T>) {
    return function (target: BaseService, propertyKey: string, descriptor: PropertyDescriptor) {
        if (!target.__graphqlSubscriptions) target.__graphqlSubscriptions = [];
        const subscriptionName = meta.name ?? propertyKey;
        if (!subscriptionName) {
            throw new Error("GraphQLSubscription: Subscription name is required (either meta.name or propertyKey must be defined)");
        }
        const subscriptionMeta = { ...meta, name: subscriptionName, propertyKey } as GraphQLSubscriptionMeta<any>;
        target.__graphqlSubscriptions.push(subscriptionMeta);
    };
}
