import { describe, test, expect } from "bun:test";
import { createUserFriendlyError, handleGraphQLError } from "../core/ErrorHandler";
import { getErrorMessage, mapZodPathToErrorCode } from "../utils/errorMessages";
import { GraphQLError } from "graphql";
import * as z from "zod";

describe('Error Handling Phase 1 Tests', () => {
    describe('User-Friendly Error Messages', () => {
        test('should return correct error message for known error code', () => {
            const errorInfo = getErrorMessage('INVALID_EMAIL');
            expect(errorInfo.userMessage).toBe('Please enter a valid email address');
            expect(errorInfo.suggestion).toBe('Check that your email follows the format: name@example.com');
            expect(errorInfo.category).toBe('validation');
        });

        test('should return fallback message for unknown error code', () => {
            const errorInfo = getErrorMessage('UNKNOWN_CODE');
            expect(errorInfo.userMessage).toBe('An unexpected error occurred');
            expect(errorInfo.category).toBe('system');
        });

        test('should map Zod paths to error codes correctly', () => {
            expect(mapZodPathToErrorCode(['email'])).toBe('INVALID_EMAIL');
            expect(mapZodPathToErrorCode(['password'])).toBe('TOO_SHORT');
            expect(mapZodPathToErrorCode(['unknownField'])).toBe('INVALID_FORMAT');
        });
    });

    describe('createUserFriendlyError function', () => {
        test('should create GraphQL error with user-friendly message', () => {
            const error = createUserFriendlyError('INVALID_EMAIL');

            expect(error).toBeInstanceOf(GraphQLError);
            expect(error.message).toBe('Please enter a valid email address');
            expect(error.extensions).toEqual({
                code: 'INVALID_EMAIL',
                category: 'validation',
                suggestion: 'Check that your email follows the format: name@example.com',
                userFriendly: true
            });
        });

        test('should allow custom message override', () => {
            const customMessage = 'Custom email error';
            const error = createUserFriendlyError('INVALID_EMAIL', customMessage);

            expect(error.message).toBe(customMessage);
            expect(error.extensions?.code).toBe('INVALID_EMAIL');
        });

        test('should merge additional extensions', () => {
            const error = createUserFriendlyError('INVALID_EMAIL', undefined, {
                extensions: { additionalField: 'test' }
            });

            expect(error.extensions?.additionalField).toBe('test');
            expect(error.extensions?.userFriendly).toBe(true);
        });
    });

    describe('handleGraphQLError function', () => {
        test('should handle Zod validation errors with user-friendly messages', () => {
            // Create a real Zod error by validating invalid data with a field name
            const userSchema = z.object({
                email: z.string().email()
            });
            let zodError: z.ZodError;

            try {
                userSchema.parse({ email: 'invalid-email' });
            } catch (error) {
                zodError = error as z.ZodError;
            }

            expect(() => handleGraphQLError(zodError!)).toThrow(GraphQLError);

            try {
                handleGraphQLError(zodError!);
            } catch (error: any) {
                expect(error.message).toBe('Please enter a valid email address');
                expect(error.extensions?.code).toBe('VALIDATION_ERROR');
                expect(error.extensions?.category).toBe('validation');
                expect(error.extensions?.userFriendly).toBe(true);
                expect(error.extensions?.validationErrors).toBeDefined();
                expect(error.extensions?.suggestion).toBe('Check that your email follows the format: name@example.com');
            }
        });

        test('should handle multiple Zod validation errors', () => {
            // Create a schema that will produce multiple validation errors
            const userSchema = z.object({
                email: z.string().email(),
                password: z.string().min(8)
            });

            let zodError: z.ZodError;

            try {
                userSchema.parse({
                    email: 'invalid-email',
                    password: 'short'
                });
            } catch (error) {
                zodError = error as z.ZodError;
            }

            expect(() => handleGraphQLError(zodError!)).toThrow(GraphQLError);

            try {
                handleGraphQLError(zodError!);
            } catch (error: any) {
                expect(error.message).toContain('Please enter a valid email address');
                expect(error.extensions?.validationErrors).toHaveLength(2);
            }
        });

        test('should handle empty Zod errors gracefully', () => {
            const zodError = new z.ZodError([]);

            expect(() => handleGraphQLError(zodError)).toThrow(GraphQLError);

            try {
                handleGraphQLError(zodError);
            } catch (error: any) {
                expect(error.message).toBe('Validation failed');
                expect(error.extensions?.code).toBe('VALIDATION_ERROR');
                expect(error.extensions?.userFriendly).toBe(true);
            }
        });

        test('should re-throw existing GraphQL errors', () => {
            const originalError = new GraphQLError('Original error', {
                extensions: { code: 'ORIGINAL' }
            });

            expect(() => handleGraphQLError(originalError)).toThrow(originalError);
        });

        test('should handle unknown errors with user-friendly message', () => {
            const unknownError = new Error('Some unknown error');

            expect(() => handleGraphQLError(unknownError)).toThrow(GraphQLError);

            try {
                handleGraphQLError(unknownError);
            } catch (error: any) {
                expect(error.message).toBe('Something went wrong on our end');
                expect(error.extensions?.code).toBe('INTERNAL_ERROR');
                expect(error.extensions?.category).toBe('system');
                expect(error.extensions?.suggestion).toBe('Please try again in a few moments. If the problem persists, contact support');
                expect(error.extensions?.userFriendly).toBe(true);
            }
        });
    });
});