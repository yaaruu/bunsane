/**
 * Cron Expression Parser for BunSane Scheduler
 * Supports standard cron expressions with 5 or 6 fields
 */

export interface CronFields {
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
    // Optional seconds field for 6-field expressions
    second?: number[];
}

export interface CronValidationResult {
    isValid: boolean;
    error?: string;
    fields?: CronFields;
}

export class CronParser {
    /**
     * Parse a cron expression into its component fields
     * @param expression Standard cron expression (e.g., "0 2 * * 1" or "*\/5 * * * *")
     * @returns Parsed cron fields or validation error
     */
    static parse(expression: string): CronValidationResult {
        if (!expression || typeof expression !== 'string') {
            return { isValid: false, error: 'Expression must be a non-empty string' };
        }

        const parts = expression.trim().split(/\s+/);
        if (parts.length !== 5 && parts.length !== 6) {
            return { isValid: false, error: 'Cron expression must have 5 or 6 fields' };
        }

        const isSixField = parts.length === 6;
        const fields: CronFields = {
            minute: [],
            hour: [],
            dayOfMonth: [],
            month: [],
            dayOfWeek: []
        };

        if (isSixField) {
            fields.second = [];
        }

        // Parse each field
        const fieldNames = isSixField
            ? ['second', 'minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek']
            : ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];

        for (let i = 0; i < parts.length; i++) {
            const fieldName = fieldNames[i]!;
            const fieldValue = parts[i]!;
            const validation = CronParser.validateField(fieldName, fieldValue);

            if (!validation.isValid) {
                return { isValid: false, error: `${fieldName}: ${validation.error}` };
            }

            (fields as any)[fieldName] = validation.values;
        }

        return { isValid: true, fields };
    }

    /**
     * Validate a single cron field
     */
    private static validateField(fieldName: string, value: string): { isValid: boolean; error?: string; values: number[] } {
        if (value === '*') {
            return { isValid: true, values: CronParser.getAllValuesForField(fieldName) };
        }

        if (value.includes('/')) {
            return CronParser.parseStepValue(fieldName, value);
        }

        if (value.includes('-')) {
            return CronParser.parseRangeValue(fieldName, value);
        }

        if (value.includes(',')) {
            return CronParser.parseListValue(fieldName, value);
        }

        // Single value
        const numValue = parseInt(value, 10);
        if (isNaN(numValue)) {
            return { isValid: false, error: `Invalid number: ${value}`, values: [] };
        }

        const limits = CronParser.getFieldLimits(fieldName);
        if (numValue < limits.min || numValue > limits.max) {
            return { isValid: false, error: `Value ${numValue} out of range (${limits.min}-${limits.max})`, values: [] };
        }

        return { isValid: true, values: [numValue] };
    }

    /**
     * Parse step values like "*\/5" or "10/2"
     */
    private static parseStepValue(fieldName: string, value: string): { isValid: boolean; error?: string; values: number[] } {
        const parts = value.split('/');
        if (parts.length !== 2) {
            return { isValid: false, error: 'Invalid step format', values: [] };
        }

        const [base, step] = parts;
        if (!base || !step) {
            return { isValid: false, error: 'Invalid step format', values: [] };
        }

        const stepNum = parseInt(step, 10);

        if (isNaN(stepNum) || stepNum <= 0) {
            return { isValid: false, error: 'Invalid step value', values: [] };
        }

        let allValues: number[];
        if (base === '*') {
            allValues = CronParser.getAllValuesForField(fieldName);
        } else if (base.includes('-')) {
            const rangeResult = CronParser.parseRangeValue(fieldName, base);
            if (!rangeResult.isValid) {
                return rangeResult;
            }
            allValues = rangeResult.values;
        } else {
            const baseNum = parseInt(base, 10);
            if (isNaN(baseNum)) {
                return { isValid: false, error: 'Invalid base value', values: [] };
            }
            const limits = CronParser.getFieldLimits(fieldName);
            if (baseNum < limits.min || baseNum > limits.max) {
                return { isValid: false, error: `Base value ${baseNum} out of range`, values: [] };
            }
            allValues = [baseNum];
        }

        const stepValues: number[] = [];
        for (let i = 0; i < allValues.length; i += stepNum) {
            const value = allValues[i];
            if (value !== undefined) {
                stepValues.push(value);
            }
        }

        return { isValid: true, values: stepValues };
    }

    /**
     * Parse range values like "1-5"
     */
    private static parseRangeValue(fieldName: string, value: string): { isValid: boolean; error?: string; values: number[] } {
        const parts = value.split('-');
        if (parts.length !== 2) {
            return { isValid: false, error: 'Invalid range format', values: [] };
        }

        const startStr = parts[0];
        const endStr = parts[1];
        if (!startStr || !endStr) {
            return { isValid: false, error: 'Invalid range format', values: [] };
        }

        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (isNaN(start) || isNaN(end)) {
            return { isValid: false, error: 'Invalid range values', values: [] };
        }

        const limits = CronParser.getFieldLimits(fieldName);
        if (start < limits.min || start > limits.max || end < limits.min || end > limits.max) {
            return { isValid: false, error: `Range values out of bounds (${limits.min}-${limits.max})`, values: [] };
        }

        if (start > end) {
            return { isValid: false, error: 'Start value cannot be greater than end value', values: [] };
        }

        const values: number[] = [];
        for (let i = start; i <= end; i++) {
            values.push(i);
        }

        return { isValid: true, values };
    }

    /**
     * Parse list values like "1,3,5"
     */
    private static parseListValue(fieldName: string, value: string): { isValid: boolean; error?: string; values: number[] } {
        const parts = value.split(',');
        const values: number[] = [];
        const limits = CronParser.getFieldLimits(fieldName);

        for (const part of parts) {
            const numValue = parseInt(part.trim(), 10);
            if (isNaN(numValue)) {
                return { isValid: false, error: `Invalid list value: ${part}`, values: [] };
            }
            if (numValue < limits.min || numValue > limits.max) {
                return { isValid: false, error: `List value ${numValue} out of range (${limits.min}-${limits.max})`, values: [] };
            }
            if (!values.includes(numValue)) {
                values.push(numValue);
            }
        }

        return { isValid: true, values: values.sort((a, b) => a - b) };
    }

    /**
     * Get all possible values for a field
     */
    private static getAllValuesForField(fieldName: string): number[] {
        const limits = this.getFieldLimits(fieldName);
        const values: number[] = [];
        for (let i = limits.min; i <= limits.max; i++) {
            values.push(i);
        }
        return values;
    }

    /**
     * Get min/max limits for each field type
     */
    private static getFieldLimits(fieldName: string): { min: number; max: number } {
        switch (fieldName) {
            case 'second':
            case 'minute':
                return { min: 0, max: 59 };
            case 'hour':
                return { min: 0, max: 23 };
            case 'dayOfMonth':
                return { min: 1, max: 31 };
            case 'month':
                return { min: 1, max: 12 };
            case 'dayOfWeek':
                return { min: 0, max: 7 }; // 0 and 7 both represent Sunday
            default:
                return { min: 0, max: 59 };
        }
    }

    /**
     * Calculate next execution time for a cron expression
     * @param cronFields Parsed cron fields
     * @param fromDate Date to calculate from (defaults to now)
     * @returns Next execution date or null if no future execution
     */
    static getNextExecution(cronFields: CronFields, fromDate: Date = new Date()): Date | null {
        const date = new Date(fromDate.getTime());

        // Start from the next minute to avoid returning the current time if it matches
        date.setMinutes(date.getMinutes() + 1);
        date.setSeconds(0, 0);

        // Try up to 1 year in the future
        const maxAttempts = 60 * 24 * 365; // 1 year in minutes
        let attempts = 0;

        while (attempts < maxAttempts) {
            if (this.matchesCronFields(date, cronFields)) {
                return new Date(date);
            }

            // Move to next minute
            date.setMinutes(date.getMinutes() + 1);
            attempts++;
        }

        return null; // No execution found within 1 year
    }

    /**
     * Check if a date matches the cron fields
     */
    private static matchesCronFields(date: Date, fields: CronFields): boolean {
        const minute = date.getMinutes();
        const hour = date.getHours();
        const dayOfMonth = date.getDate();
        const month = date.getMonth() + 1; // JavaScript months are 0-based
        const dayOfWeek = date.getDay(); // 0 = Sunday

        return (
            (fields.second ? fields.second.includes(date.getSeconds()) : true) &&
            fields.minute.includes(minute) &&
            fields.hour.includes(hour) &&
            fields.dayOfMonth.includes(dayOfMonth) &&
            fields.month.includes(month) &&
            (fields.dayOfWeek.includes(dayOfWeek) || fields.dayOfWeek.includes(dayOfWeek === 0 ? 7 : dayOfWeek))
        );
    }

    /**
     * Validate a cron expression
     * @param expression Cron expression to validate
     * @returns Validation result
     */
    static validate(expression: string): CronValidationResult {
        return this.parse(expression);
    }

    /**
     * Get human-readable description of a cron expression
     * @param expression Cron expression
     * @returns Human-readable description
     */
    static describe(expression: string): string {
        const result = this.parse(expression);
        if (!result.isValid || !result.fields) {
            return 'Invalid cron expression';
        }

        const fields = result.fields;
        const descriptions: string[] = [];

        // Describe each field
        if (fields.second && fields.second.length > 0) {
            descriptions.push(`at second ${this.describeValues(fields.second)}`);
        }

        descriptions.push(`at minute ${this.describeValues(fields.minute)}`);
        descriptions.push(`at hour ${this.describeValues(fields.hour)}`);
        descriptions.push(`on day ${this.describeValues(fields.dayOfMonth)} of the month`);
        descriptions.push(`in month ${this.describeValues(fields.month)}`);
        descriptions.push(`on day ${this.describeValues(fields.dayOfWeek)} of the week`);

        return descriptions.join(', ');
    }

    /**
     * Get human-readable description of numeric values
     */
    private static describeValues(values: number[]): string {
        if (!values || values.length === 0) return 'none';
        if (values.length === 1) return values[0]!.toString();

        // Check for consecutive ranges
        const ranges: string[] = [];
        let start = values[0]!;
        let prev = values[0]!;

        for (let i = 1; i < values.length; i++) {
            const current = values[i]!;
            if (current === prev + 1) {
                prev = current;
            } else {
                ranges.push(start === prev ? start.toString() : `${start}-${prev}`);
                start = current;
                prev = current;
            }
        }
        ranges.push(start === prev ? start.toString() : `${start}-${prev}`);

        return ranges.join(',');
    }
}