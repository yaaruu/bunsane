/**
 * User-friendly error message mappings for the BunSane framework
 * Maps technical error codes and validation issues to clear, actionable messages
 */

export interface ErrorMessage {
    userMessage: string;
    suggestion?: string;
    category: 'validation' | 'authentication' | 'authorization' | 'system' | 'network';
}

export const ERROR_MESSAGES: Record<string, ErrorMessage> = {
    // Validation Errors
    'INVALID_EMAIL': {
        userMessage: 'Please enter a valid email address',
        suggestion: 'Check that your email follows the format: name@example.com',
        category: 'validation'
    },
    'REQUIRED_FIELD': {
        userMessage: 'This field is required',
        suggestion: 'Please fill in all required fields before submitting',
        category: 'validation'
    },
    'TOO_SHORT': {
        userMessage: 'This value is too short',
        suggestion: 'Please enter a longer value that meets the minimum requirements',
        category: 'validation'
    },
    'TOO_LONG': {
        userMessage: 'This value is too long',
        suggestion: 'Please shorten your input to meet the maximum length requirement',
        category: 'validation'
    },
    'INVALID_FORMAT': {
        userMessage: 'This value has an invalid format',
        suggestion: 'Please check the expected format and try again',
        category: 'validation'
    },
    'DUPLICATE_VALUE': {
        userMessage: 'This value already exists',
        suggestion: 'Please choose a different value or contact support if you believe this is an error',
        category: 'validation'
    },

    // Authentication Errors
    'INVALID_CREDENTIALS': {
        userMessage: 'Invalid username or password',
        suggestion: 'Please check your credentials and try again, or use the forgot password option',
        category: 'authentication'
    },
    'ACCOUNT_LOCKED': {
        userMessage: 'Your account has been temporarily locked',
        suggestion: 'Please wait a few minutes before trying again, or contact support',
        category: 'authentication'
    },
    'SESSION_EXPIRED': {
        userMessage: 'Your session has expired',
        suggestion: 'Please log in again to continue',
        category: 'authentication'
    },

    // Authorization Errors
    'INSUFFICIENT_PERMISSIONS': {
        userMessage: 'You don\'t have permission to perform this action',
        suggestion: 'Please contact your administrator if you believe this is an error',
        category: 'authorization'
    },
    'ACCESS_DENIED': {
        userMessage: 'Access denied',
        suggestion: 'You may not have the required permissions for this resource',
        category: 'authorization'
    },

    // System Errors
    'INTERNAL_ERROR': {
        userMessage: 'Something went wrong on our end',
        suggestion: 'Please try again in a few moments. If the problem persists, contact support',
        category: 'system'
    },
    'SERVICE_UNAVAILABLE': {
        userMessage: 'Service is temporarily unavailable',
        suggestion: 'Please try again later',
        category: 'system'
    },

    // Network Errors
    'NETWORK_ERROR': {
        userMessage: 'Unable to connect to the server',
        suggestion: 'Please check your internet connection and try again',
        category: 'network'
    },
    'TIMEOUT_ERROR': {
        userMessage: 'Request timed out',
        suggestion: 'Please try again. If the problem continues, the service may be experiencing high load',
        category: 'network'
    }
};

/**
 * Get a user-friendly error message by code
 */
export function getErrorMessage(code: string): ErrorMessage {
    return ERROR_MESSAGES[code] || {
        userMessage: 'An unexpected error occurred',
        suggestion: 'Please try again or contact support if the problem persists',
        category: 'system'
    };
}

/**
 * Map Zod validation error paths to user-friendly error codes
 */
export const ZOD_ERROR_MAPPINGS: Record<string, string> = {
    'email': 'INVALID_EMAIL',
    'password': 'TOO_SHORT', // Will be refined based on actual validation rules
    'username': 'INVALID_FORMAT',
    'name': 'REQUIRED_FIELD',
    'title': 'REQUIRED_FIELD',
    'content': 'REQUIRED_FIELD',
    'description': 'TOO_LONG'
};

/**
 * Convert Zod error path to user-friendly error code
 */
export function mapZodPathToErrorCode(path: string[]): string {
    // If path is empty, we can't determine the field, return generic error
    if (path.length === 0) {
        return 'INVALID_FORMAT';
    }

    const fieldName = path[0]?.toLowerCase();
    if (!fieldName) return 'INVALID_FORMAT';

    // Direct field mappings
    switch (fieldName) {
        case 'email':
            return 'INVALID_EMAIL';
        case 'password':
            return 'TOO_SHORT';
        case 'username':
            return 'INVALID_FORMAT';
        case 'name':
        case 'title':
        case 'content':
        case 'description':
            return 'REQUIRED_FIELD';
        default:
            return 'INVALID_FORMAT';
    }
}