import { GraphQLError } from "graphql";
import { logger } from "../../core/Logger";
import { type ZodType } from "zod";
import * as z from "zod";

/** Check if error is a GraphQLError (handles cross-package version mismatches) */
function isGraphQLError(error: unknown): error is GraphQLError {
  return error instanceof GraphQLError ||
    (error !== null && typeof error === 'object' && 'extensions' in error &&
     'message' in error && typeof (error as any).message === 'string');
}

export interface ResolverDefinition {
  name: string;
  type: "Query" | "Mutation" | "Subscription";
  service: any;
  propertyKey: string;
  zodSchema?: ZodType;
  hasInput?: boolean;
}

export class ResolverBuilder {
  private resolvers: Record<string, Record<string, Function>> = {
    Query: {},
    Mutation: {},
    Subscription: {}
  };

  /**
   * Add a resolver definition
   */
  addResolver(definition: ResolverDefinition): void {
    const { name, type, service, propertyKey, zodSchema, hasInput } = definition;

    let resolver: any;

    if (type === "Subscription") {
      // Subscriptions need special handling with subscribe/resolve pattern
      resolver = hasInput
        ? this.createSubscriptionResolverWithInput(service, propertyKey, zodSchema)
        : this.createSubscriptionResolverWithoutInput(service, propertyKey);
    } else {
      // Queries and Mutations use regular resolver pattern
      resolver = hasInput
        ? this.createResolverWithInput(service, propertyKey, zodSchema)
        : this.createResolverWithoutInput(service, propertyKey);
    }

    // Ensure the resolver category exists (should always exist due to initialization)
    if (!this.resolvers[type]) {
      this.resolvers[type] = {};
    }
    this.resolvers[type][name] = resolver;
    logger.trace(`Added ${type} resolver: ${name}`);
  }

  /**
   * Create a resolver that expects input arguments
   */
  private createResolverWithInput(service: any, propertyKey: string, zodSchema?: ZodType): Function {
    return async (_: any, args: any, context: any, info: any) => {
      try {
        const inputArgs = args.input || args;

        // Automatically validate with Zod schema if provided
        if (zodSchema) {
          try {
            const validated = zodSchema.parse(inputArgs);
            return await service[propertyKey](validated, context, info);
          } catch (error) {
            if (error instanceof z.ZodError) {
              // Let handleGraphQLError convert Zod errors to user-friendly messages
              const { handleGraphQLError } = await import("../../core/ErrorHandler");
              handleGraphQLError(error);
            }
            throw error;
          }
        } else {
          return await service[propertyKey](inputArgs, context, info);
        }
      } catch (error) {
        logger.error(`Error in resolver with input:`);
        logger.error(error);
        if (isGraphQLError(error)) {
          throw error;
        }
        throw new GraphQLError(`Internal error`, {
          extensions: {
            code: "INTERNAL_ERROR",
            originalError: process.env.NODE_ENV === 'development' ? error : undefined
          }
        });
      }
    };
  }

  /**
   * Create a resolver that doesn't expect input arguments
   */
  private createResolverWithoutInput(service: any, propertyKey: string): Function {
    return async (_: any, args: any, context: any, info: any) => {
      try {
        const result = await service[propertyKey]({}, context, info);
        return result;
      } catch (error) {
        logger.error(`Error in resolver without input:`);
        logger.error(error);
        if (isGraphQLError(error)) {
          throw error;
        }
        throw new GraphQLError(`Internal error`, {
          extensions: {
            code: "INTERNAL_ERROR",
            originalError: process.env.NODE_ENV === 'development' ? error : undefined
          }
        });
      }
    };
  }

  /**
   * Create a subscription resolver with input (returns { subscribe, resolve })
   */
  private createSubscriptionResolverWithInput(service: any, propertyKey: string, zodSchema?: ZodType): any {
    return {
      subscribe: async (_: any, args: any, context: any, info: any) => {
        try {
          const inputArgs = args.input || args;

          // Automatically validate with Zod schema if provided
          if (zodSchema) {
            try {
              const validated = zodSchema.parse(inputArgs);
              return await service[propertyKey](validated, context, info);
            } catch (error) {
              if (error instanceof z.ZodError) {
                const { handleGraphQLError } = await import("../../core/ErrorHandler");
                handleGraphQLError(error);
              }
              throw error;
            }
          } else {
            return await service[propertyKey](inputArgs, context, info);
          }
        } catch (error) {
          logger.error(`Error in subscription with input:`);
          logger.error(error);
          if (isGraphQLError(error)) {
            throw error;
          }
          throw new GraphQLError(`Internal error in subscription`, {
            extensions: {
              code: "INTERNAL_ERROR",
              originalError: process.env.NODE_ENV === 'development' ? error : undefined
            }
          });
        }
      },
      resolve: (payload: any) => payload
    };
  }

  /**
   * Create a subscription resolver without input (returns { subscribe, resolve })
   */
  private createSubscriptionResolverWithoutInput(service: any, propertyKey: string): any {
    return {
      subscribe: async (_: any, args: any, context: any, info: any) => {
        try {
          return await service[propertyKey]({}, context, info);
        } catch (error) {
          logger.error(`Error in subscription without input:`);
          logger.error(error);
          if (isGraphQLError(error)) {
            throw error;
          }
          throw new GraphQLError(`Internal error in subscription`, {
            extensions: {
              code: "INTERNAL_ERROR",
              originalError: process.env.NODE_ENV === 'development' ? error : undefined
            }
          });
        }
      },
      resolve: (payload: any) => payload
    };
  }

  /**
   * Get all built resolvers
   */
  getResolvers(): Record<string, Record<string, Function>> {
    return { ...this.resolvers };
  }

  /**
   * Get resolvers for a specific type
   */
  getResolversForType(type: "Query" | "Mutation" | "Subscription"): Record<string, Function> {
    return { ...this.resolvers[type] };
  }

  /**
   * Clear all resolvers (for reuse)
   */
  clear(): void {
    this.resolvers = {
      Query: {},
      Mutation: {},
      Subscription: {}
    };
  }

  /**
   * Add a scalar resolver
   */
  addScalarResolver(name: string, resolver: any): void {
    if (!this.resolvers[name]) {
      this.resolvers[name] = resolver;
      logger.trace(`Added scalar resolver: ${name}`);
    }
  }

  /**
   * Get statistics
   */
  getStats(): { queries: number; mutations: number; subscriptions: number } {
    return {
      queries: Object.keys(this.resolvers.Query ?? {}).length,
      mutations: Object.keys(this.resolvers.Mutation ?? {}).length,
      subscriptions: Object.keys(this.resolvers.Subscription ?? {}).length
    };
  }
}