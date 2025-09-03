import * as z from "zod";
import { GraphQLError, type GraphQLErrorOptions } from "graphql";

export function responseError(message: string, extensions?: GraphQLErrorOptions) {
    return new GraphQLError(message, {
        extensions: {
            code: "UNKNOWN_ERROR",
        },
        ...extensions
    });
}

export function handleGraphQLError(err: any): never {
    if (err instanceof z.ZodError) {
        const errorMessages = err.issues.map((error: any) => 
            `${error.path.join('.')}: ${error.message}`
        ).join(', ');
        
        throw new GraphQLError(`Validation failed: ${errorMessages}`, {
            extensions: {
                code: "VALIDATION_ERROR",
                validationErrors: err.issues
            }
        });
    }
    if (err instanceof GraphQLError) {
        throw err;
    }
    throw new GraphQLError("An unexpected error occurred", {
        extensions: {
            code: "INTERNAL_ERROR",
            originalError: process.env.NODE_ENV === 'development' ? err : undefined
        }
    });
}
