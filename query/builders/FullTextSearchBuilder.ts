/**
 * Full-Text Search Filter Builder
 *
 * Provides PostgreSQL full-text search capabilities as a custom filter builder.
 * Demonstrates advanced filter builder patterns including validation and options.
 */

import type { FilterBuilder, FilterBuilderOptions } from "../FilterBuilder";
import type { QueryFilter } from "../QueryContext";
import type { QueryContext } from "../QueryContext";

/**
 * Full-text search filter value interface
 */
export interface FullTextFilterValue {
    /** The search query text */
    query: string;
    /** Optional language for text search (defaults to 'english') */
    language?: string;
    /** Optional search type: 'plain' (default), 'phrase', 'web', 'tsquery' */
    type?: 'plain' | 'phrase' | 'web' | 'tsquery';
}

/**
 * Validate full-text search filter values
 */
function validateFullTextFilter(filter: QueryFilter): boolean {
    const value = filter.value as FullTextFilterValue;

    if (!value || typeof value !== 'object') {
        return false;
    }

    if (!value.query || typeof value.query !== 'string' || value.query.trim().length === 0) {
        return false;
    }

    if (value.language && typeof value.language !== 'string') {
        return false;
    }

    if (value.type && !['plain', 'phrase', 'web', 'tsquery'].includes(value.type)) {
        return false;
    }

    return true;
}

/**
 * Full-text search filter builder using PostgreSQL's built-in text search
 *
 * Supports multiple search types:
 * - plain: plainto_tsquery() - simple natural language search
 * - phrase: phraseto_tsquery() - exact phrase matching
 * - web: websearch_to_tsquery() - web-style search syntax
 * - tsquery: raw tsquery syntax for advanced users
 *
 * @param filter - Filter containing FullTextFilterValue
 * @param alias - Component table alias
 * @param context - Query context for parameter management
 * @returns SQL fragment for full-text search
 */
export const fullTextSearchBuilder: FilterBuilder = (
    filter: QueryFilter,
    alias: string,
    context: QueryContext
): { sql: string; addedParams: number } => {
    const value = filter.value as FullTextFilterValue;
    const { query, language = 'english', type = 'plain' } = value;

    // Build the text search vector from the specified field
    const fieldPath = filter.field.includes('.')
        ? filter.field.split('.').map(p => `'${p}'`).join('->')
        : `'${filter.field}'`;

    const vectorSql = `to_tsvector('${language}', ${alias}.data->${fieldPath})`;

    // Choose the appropriate query function based on type
    let queryFunction: string;
    switch (type) {
        case 'phrase':
            queryFunction = 'phraseto_tsquery';
            break;
        case 'web':
            queryFunction = 'websearch_to_tsquery';
            break;
        case 'tsquery':
            queryFunction = 'to_tsquery';
            break;
        case 'plain':
        default:
            queryFunction = 'plainto_tsquery';
            break;
    }

    const querySql = `${queryFunction}('${language}', $${context.addParam(query)})`;

    return {
        sql: `${vectorSql} @@ ${querySql}`,
        addedParams: 1
    };
};

/**
 * Full-text search filter builder with ranking (returns relevance score)
 *
 * This builder includes ranking information that can be used for ordering results
 * by relevance. Note: This requires modifying the SELECT clause to include the rank.
 *
 * @param filter - Filter containing FullTextFilterValue
 * @param alias - Component table alias
 * @param context - Query context for parameter management
 * @returns SQL fragment with ranking
 */
export const fullTextSearchWithRankBuilder: FilterBuilder = (
    filter: QueryFilter,
    alias: string,
    context: QueryContext
): { sql: string; addedParams: number } => {
    const value = filter.value as FullTextFilterValue;
    const { query, language = 'english', type = 'plain' } = value;

    // Build the text search vector from the specified field
    const fieldPath = filter.field.includes('.')
        ? filter.field.split('.').map(p => `'${p}'`).join('->')
        : `'${filter.field}'`;

    const vectorSql = `to_tsvector('${language}', ${alias}.data->${fieldPath})`;

    // Choose the appropriate query function based on type
    let queryFunction: string;
    switch (type) {
        case 'phrase':
            queryFunction = 'phraseto_tsquery';
            break;
        case 'web':
            queryFunction = 'websearch_to_tsquery';
            break;
        case 'tsquery':
            queryFunction = 'to_tsquery';
            break;
        case 'plain':
        default:
            queryFunction = 'plainto_tsquery';
            break;
    }

    const querySql = `${queryFunction}('${language}', $${context.addParam(query)})`;

    // Include ranking in the condition (can be used for ordering)
    const rankSql = `ts_rank(${vectorSql}, ${querySql})`;

    return {
        sql: `${vectorSql} @@ ${querySql} /* RANK: ${rankSql} */`,
        addedParams: 1
    };
};

/**
 * Full-text search filter builder options
 */
export const fullTextSearchOptions: FilterBuilderOptions = {
    supportsLateral: true, // Full-text search works well with LATERAL joins
    requiresIndex: true,   // Benefits greatly from GIN indexes on tsvector columns
    complexityScore: 3,    // Moderate complexity due to text processing
    validate: validateFullTextFilter
};

/**
 * Full-text search with ranking options
 */
export const fullTextSearchWithRankOptions: FilterBuilderOptions = {
    supportsLateral: true,
    requiresIndex: true,
    complexityScore: 4, // Higher complexity due to ranking calculation
    validate: validateFullTextFilter
};

/**
 * Helper function to create a full-text search filter with custom options
 *
 * @param language - Text search language (defaults to 'english')
 * @param searchType - Search type ('plain', 'phrase', 'web', 'tsquery')
 * @returns Configured filter builder and options
 */
export function createFullTextSearchBuilder(
    language: string = 'english',
    searchType: 'plain' | 'phrase' | 'web' | 'tsquery' = 'plain'
): { builder: FilterBuilder; options: FilterBuilderOptions } {
    const builder: FilterBuilder = (filter: QueryFilter, alias: string, context: QueryContext) => {
        const value = filter.value as FullTextFilterValue;
        const query = value.query;

        // Build the text search vector from the specified field
        const fieldPath = filter.field.includes('.')
            ? filter.field.split('.').map(p => `'${p}'`).join('->')
            : `'${filter.field}'`;

        const vectorSql = `to_tsvector('${language}', ${alias}.data->${fieldPath})`;

        // Choose the appropriate query function based on type
        let queryFunction: string;
        switch (searchType) {
            case 'phrase':
                queryFunction = 'phraseto_tsquery';
                break;
            case 'web':
                queryFunction = 'websearch_to_tsquery';
                break;
            case 'tsquery':
                queryFunction = 'to_tsquery';
                break;
            case 'plain':
            default:
                queryFunction = 'plainto_tsquery';
                break;
        }

        const querySql = `${queryFunction}('${language}', $${context.addParam(query)})`;

        return {
            sql: `${vectorSql} @@ ${querySql}`,
            addedParams: 1
        };
    };

    return {
        builder,
        options: {
            supportsLateral: true,
            requiresIndex: true,
            complexityScore: 3,
            validate: validateFullTextFilter
        }
    };
}