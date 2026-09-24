import { GraphQLError } from "graphql";
import { logger } from "../../core/Logger";
import { type ZodType } from "zod";
import * as z from "zod";
import { isVerboseErrors } from "../../core/envMode";
import { handleGraphQLError } from "../../core/ErrorHandler";
import {
  containsFileOrBlob,
  isUploadWrapped,
  sweepValidateArgs,
} from "../uploadGuard";

function isGraphQLError(error: unknown): error is GraphQLError {
  return error instanceof GraphQLError ||
    (error !== null && typeof error === "object" && "extensions" in error &&
     "message" in error && typeof error.message === "string");
}

function inputFromArgs(args: unknown): unknown {
  if (args && typeof args === "object" && "input" in args) {
    return args.input;
  }
  return args;
}

async function callService(service: Record<string, unknown>, propertyKey: string, ...methodArgs: unknown[]): Promise<unknown> {
  const method = service[propertyKey];
  if (typeof method !== "function") {
    throw new Error(`Resolver method ${propertyKey} is not a function`);
  }
  return Reflect.apply(method, service, methodArgs);
}

export interface ResolverDefinition {
  name: string;
  type: "Query" | "Mutation" | "Subscription";
  service: Record<string, unknown>;
  propertyKey: string;
  zodSchema?: ZodType;
  hasInput?: boolean;
}

type ResolverFn = Function;

export class ResolverBuilder {
  private resolvers: Record<string, Record<string, ResolverFn>> = {
    Query: {},
    Mutation: {},
    Subscription: {},
  };

  addResolver(definition: ResolverDefinition): void {
    const { name, type, service, propertyKey, zodSchema, hasInput } = definition;

    const resolver = type === "Subscription"
      ? hasInput
        ? this.createSubscriptionResolverWithInput(service, propertyKey, zodSchema)
        : this.createSubscriptionResolverWithoutInput(service, propertyKey)
      : hasInput
        ? this.createResolverWithInput(service, propertyKey, zodSchema)
        : this.createResolverWithoutInput(service, propertyKey);

    const bucket = this.resolvers[type] ?? {};
    bucket[name] = resolver;
    this.resolvers[type] = bucket;
    logger.trace(`Added ${type} resolver: ${name}`);
  }

  /**
   * Skip the upload sweep when the method is already wrapped or a cheap scan
   * finds no File/Blob. Undecorated methods that receive files are still
   * swept (SEC-06 safety net).
   */
  private async guardUploads(service: Record<string, unknown>, propertyKey: string, args: unknown): Promise<void> {
    if (isUploadWrapped(service[propertyKey])) return;
    if (!containsFileOrBlob(args)) return;
    await sweepValidateArgs([args]);
  }

  private createResolverWithInput(service: Record<string, unknown>, propertyKey: string, zodSchema?: ZodType): ResolverFn {
    return async (_parent: unknown, args: unknown, context: unknown, info: unknown) => {
      try {
        const inputArgs = inputFromArgs(args);
        await this.guardUploads(service, propertyKey, inputArgs);

        if (zodSchema) {
          try {
            const validated = zodSchema.parse(inputArgs);
            return await callService(service, propertyKey, validated, context, info);
          } catch (error) {
            if (error instanceof z.ZodError) {
              handleGraphQLError(error);
            }
            throw error;
          }
        }
        return await callService(service, propertyKey, inputArgs, context, info);
      } catch (error) {
        logger.error(`Error in resolver with input:`);
        logger.error(error);
        if (isGraphQLError(error)) throw error;
        throw new GraphQLError(`Internal error`, {
          extensions: {
            code: "INTERNAL_ERROR",
            originalError: isVerboseErrors() ? error : undefined,
          },
        });
      }
    };
  }

  private createResolverWithoutInput(service: Record<string, unknown>, propertyKey: string): ResolverFn {
    return async (_parent: unknown, args: unknown, context: unknown, info: unknown) => {
      try {
        await this.guardUploads(service, propertyKey, args);
        return await callService(service, propertyKey, {}, context, info);
      } catch (error) {
        logger.error(`Error in resolver without input:`);
        logger.error(error);
        if (isGraphQLError(error)) throw error;
        throw new GraphQLError(`Internal error`, {
          extensions: {
            code: "INTERNAL_ERROR",
            originalError: isVerboseErrors() ? error : undefined,
          },
        });
      }
    };
  }

  private createSubscriptionResolverWithInput(service: Record<string, unknown>, propertyKey: string, zodSchema?: ZodType): ResolverFn {
    return {
      subscribe: async (_parent: unknown, args: unknown, context: unknown, info: unknown) => {
        try {
          const inputArgs = inputFromArgs(args);
          if (zodSchema) {
            try {
              const validated = zodSchema.parse(inputArgs);
              return await callService(service, propertyKey, validated, context, info);
            } catch (error) {
              if (error instanceof z.ZodError) {
                handleGraphQLError(error);
              }
              throw error;
            }
          }
          return await callService(service, propertyKey, inputArgs, context, info);
        } catch (error) {
          logger.error(`Error in subscription with input:`);
          logger.error(error);
          if (isGraphQLError(error)) throw error;
          throw new GraphQLError(`Internal error in subscription`, {
            extensions: {
              code: "INTERNAL_ERROR",
              originalError: isVerboseErrors() ? error : undefined,
            },
          });
        }
      },
      resolve: (payload: unknown) => payload,
    } as unknown as ResolverFn;
  }

  private createSubscriptionResolverWithoutInput(service: Record<string, unknown>, propertyKey: string): ResolverFn {
    return {
      subscribe: async (_parent: unknown, _args: unknown, context: unknown, info: unknown) => {
        try {
          return await callService(service, propertyKey, {}, context, info);
        } catch (error) {
          logger.error(`Error in subscription without input:`);
          logger.error(error);
          if (isGraphQLError(error)) throw error;
          throw new GraphQLError(`Internal error in subscription`, {
            extensions: {
              code: "INTERNAL_ERROR",
              originalError: isVerboseErrors() ? error : undefined,
            },
          });
        }
      },
      resolve: (payload: unknown) => payload,
    } as unknown as ResolverFn;
  }

  getResolvers(): Record<string, Record<string, ResolverFn>> {
    return { ...this.resolvers };
  }

  getResolversForType(type: "Query" | "Mutation" | "Subscription"): Record<string, ResolverFn> {
    return { ...(this.resolvers[type] ?? {}) };
  }

  clear(): void {
    this.resolvers = {
      Query: {},
      Mutation: {},
      Subscription: {},
    };
  }

  addScalarResolver(name: string, resolver: object): void {
    this.resolvers[name] = resolver as unknown as Record<string, ResolverFn>;
    logger.trace(`Added scalar resolver: ${name}`);
  }

  getStats(): { queries: number; mutations: number; subscriptions: number } {
    return {
      queries: Object.keys(this.resolvers.Query ?? {}).length,
      mutations: Object.keys(this.resolvers.Mutation ?? {}).length,
      subscriptions: Object.keys(this.resolvers.Subscription ?? {}).length,
    };
  }
}
