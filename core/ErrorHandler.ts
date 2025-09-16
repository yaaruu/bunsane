import * as z from "zod";
import { GraphQLError, type GraphQLErrorOptions } from "graphql";
import { logger } from "./Logger";
import { getErrorMessage, mapZodPathToErrorCode, type ErrorMessage } from "../utils/errorMessages";

export function responseError(message: string, extensions?: GraphQLErrorOptions) {
    return new GraphQLError(message, {
        extensions: {
            code: "UNKNOWN_ERROR",
        },
        ...extensions
    });
}

/**
 * Create a user-friendly error response
 */
export function createUserFriendlyError(code: string, customMessage?: string, extensions?: GraphQLErrorOptions) {
    const errorInfo = getErrorMessage(code);

    const baseExtensions = {
        code,
        category: errorInfo.category,
        suggestion: errorInfo.suggestion,
        userFriendly: true
    };

    return new GraphQLError(customMessage || errorInfo.userMessage, {
        extensions: {
            ...baseExtensions,
            ...extensions?.extensions
        }
    });
}

export function handleGraphQLError(err: any): never {
    if (err instanceof z.ZodError) {
        // Convert Zod errors to user-friendly messages
        const userFriendlyErrors = err.issues.map((issue: any) => {
            const errorCode = mapZodPathToErrorCode(issue.path);
            const errorInfo = getErrorMessage(errorCode);
            return {
                field: issue.path.join('.'),
                message: errorInfo.userMessage,
                suggestion: errorInfo.suggestion,
                code: errorCode
            };
        });

        if (userFriendlyErrors.length === 0) {
            throw new GraphQLError("Validation failed", {
                extensions: {
                    code: "VALIDATION_ERROR",
                    category: "validation",
                    userFriendly: true
                }
            });
        }

        const primaryError = userFriendlyErrors[0]!;
        const errorMessage = userFriendlyErrors.length === 1
            ? primaryError.message
            : `${primaryError.message} (and ${userFriendlyErrors.length - 1} other validation issue${userFriendlyErrors.length > 2 ? 's' : ''})`;

        throw new GraphQLError(errorMessage, {
            extensions: {
                code: "VALIDATION_ERROR",
                category: "validation",
                validationErrors: userFriendlyErrors,
                suggestion: primaryError.suggestion,
                userFriendly: true
            }
        });
    }
    if (err instanceof GraphQLError) {
        throw err;
    }
    logger.error("Unknown error in handleGraphQLError:");
    logger.error(err);

    const errorInfo = getErrorMessage("INTERNAL_ERROR");
    throw new GraphQLError(errorInfo.userMessage, {
        extensions: {
            code: "INTERNAL_ERROR",
            category: errorInfo.category,
            suggestion: errorInfo.suggestion,
            userFriendly: true,
            node_env: process.env.NODE_ENV,
            originalError: process.env.NODE_ENV === 'development' ? err : undefined
        }
    });
}
