import { getAllArchetypeSchemas, getArchetypeSchema } from "../core/ArcheType";
import { logger as MainLogger } from "../core/Logger";

const logger = MainLogger.child({ scope: "ArchetypeOperations" });

export interface ArchetypeOperationConfig {
    enableQueries?: {
        get?: boolean;      // getArchetypeName(id: ID!)
        list?: boolean;     // listArchetypeNames(filter, limit, offset)
    };
    enableMutations?: {
        create?: boolean;   // createArchetypeName(input)
        update?: boolean;   // updateArchetypeName(id, input)
        delete?: boolean;   // deleteArchetypeName(id)
    };
}

/**
 * Generate GraphQL Query and Mutation fields for archetypes
 * This uses the cached archetype schemas to create CRUD operations
 */
export function generateArchetypeOperations(config: ArchetypeOperationConfig = {}) {
    const {
        enableQueries = { get: true, list: true },
        enableMutations = { create: true, update: true, delete: true }
    } = config;

    const schemas = getAllArchetypeSchemas();
    logger.trace(`getAllArchetypeSchemas returned ${schemas.length} schemas`);
    
    let typeDefs = "\n# Auto-generated Archetype Types\n";
    const queryFields: string[] = [];
    const mutationFields: string[] = [];
    const resolvers: any = { Query: {}, Mutation: {} };

    // Track defined types to prevent duplicates
    const definedTypes = new Set<string>();

    schemas.forEach(({ zodSchema, graphqlSchema }) => {
        // Extract archetype name from the schema
        const archetypeName = extractArchetypeName(graphqlSchema);
        if (!archetypeName) {
            logger.warn(`Could not extract archetype name from schema: ${graphqlSchema.substring(0, 100)}`);
            return;
        }

        logger.trace(`Generating operations for archetype: ${archetypeName}`);

        // Add the archetype type definition (without Query/Mutation)
        // Extract and deduplicate type definitions
        const typeDefinitions = extractTypeDefinitions(graphqlSchema);
        const deduplicatedTypes = deduplicateTypeDefinitions(typeDefinitions, definedTypes);
        logger.trace(`Adding ${deduplicatedTypes.length} characters of type definitions for ${archetypeName}`);
        typeDefs += deduplicatedTypes;
    });

    typeDefs += "\n# END AUTO-GENERATED TYPES\n";
    logger.trace(`Final typeDefs length: ${typeDefs.length}`);

    // Return types only, without operations
    return { typeDefs, queryFields, mutationFields, resolvers };
}

/**
 * WIP
 * Generate full archetype operations including types, queries, and mutations
 */
//TODO: Implement this
export function generateArchetypeOperationsWithCRUD(config: ArchetypeOperationConfig = {}) {
    const {
        enableQueries = { get: true, list: true },
        enableMutations = { create: true, update: true, delete: true }
    } = config;

    const schemas = getAllArchetypeSchemas();
    let typeDefs = "\n# Auto-generated Archetype Types\n";
    const queryFields: string[] = [];
    const mutationFields: string[] = [];
    const resolvers: any = { Query: {}, Mutation: {} };

    schemas.forEach(({ zodSchema, graphqlSchema }) => {
        // Extract archetype name from the schema
        const archetypeName = extractArchetypeName(graphqlSchema);
        if (!archetypeName) return;

        logger.trace(`Generating operations for archetype: ${archetypeName}`);

        // Add the archetype type definition (without Query/Mutation)
        typeDefs += extractTypeDefinitions(graphqlSchema);

        // Generate filter input type
        typeDefs += generateFilterInput(archetypeName, zodSchema);

        // Generate create input type
        typeDefs += generateCreateInput(archetypeName, zodSchema);

        // Generate update input type
        typeDefs += generateUpdateInput(archetypeName, zodSchema);

        // Generate Query operations
        if (enableQueries?.get) {
            queryFields.push(`get${archetypeName}(id: ID!): ${archetypeName}`);
            resolvers.Query[`get${archetypeName}`] = createGetResolver(archetypeName);
        }

        if (enableQueries?.list) {
            queryFields.push(`list${archetypeName}s(filter: ${archetypeName}Filter, limit: Int, offset: Int): [${archetypeName}!]!`);
            resolvers.Query[`list${archetypeName}s`] = createListResolver(archetypeName);
        }

        // Generate Mutation operations
        if (enableMutations?.create) {
            mutationFields.push(`create${archetypeName}(input: Create${archetypeName}Input!): ${archetypeName}!`);
            resolvers.Mutation[`create${archetypeName}`] = createCreateResolver(archetypeName);
        }

        if (enableMutations?.update) {
            mutationFields.push(`update${archetypeName}(id: ID!, input: Update${archetypeName}Input!): ${archetypeName}!`);
            resolvers.Mutation[`update${archetypeName}`] = createUpdateResolver(archetypeName);
        }

        if (enableMutations?.delete) {
            mutationFields.push(`delete${archetypeName}(id: ID!): Boolean!`);
            resolvers.Mutation[`delete${archetypeName}`] = createDeleteResolver(archetypeName);
        }
    });

    return { typeDefs, queryFields, mutationFields, resolvers };
}

function extractArchetypeName(graphqlSchema: string): string | null {
    const match = graphqlSchema.match(/type (\w+) \{/);
    return match ? match[1] ?? null : null;
}

function extractTypeDefinitions(graphqlSchema: string): string {
    // Remove Query and Mutation types, keep only object types and enums
    const lines = graphqlSchema.split('\n');
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('type Query') && 
               !trimmed.startsWith('type Mutation') &&
               !trimmed.startsWith('type Subscription');
    });
    return filtered.join('\n') + '\n';
}

/**
 * Deduplicates type definitions by tracking which types have already been defined.
 * Parses the type definitions and only returns new ones.
 */
function deduplicateTypeDefinitions(typeDefinitions: string, definedTypes: Set<string>): string {
    const lines = typeDefinitions.split('\n');
    const result: string[] = [];
    let currentType = '';
    let currentTypeName = '';
    let inTypeDefinition = false;

    for (const line of lines) {
        const trimmed = line.trim();
        
        // Check if this is the start of a type/enum/input definition
        const typeMatch = trimmed.match(/^(type|enum|input)\s+(\w+)/);
        
        if (typeMatch) {
            // Save previous type if we were in one
            if (inTypeDefinition && currentTypeName && !definedTypes.has(currentTypeName)) {
                result.push(currentType);
                definedTypes.add(currentTypeName);
            }
            
            // Start new type
            currentTypeName = typeMatch[2] || '';
            currentType = line + '\n';
            inTypeDefinition = true;
        } else if (inTypeDefinition) {
            currentType += line + '\n';
            
            // Check if this is the closing brace
            if (trimmed === '}') {
                // End of type definition
                if (!definedTypes.has(currentTypeName)) {
                    result.push(currentType);
                    definedTypes.add(currentTypeName);
                    logger.trace(`Added type definition: ${currentTypeName}`);
                } else {
                    logger.trace(`Skipped duplicate type definition: ${currentTypeName}`);
                }
                currentType = '';
                currentTypeName = '';
                inTypeDefinition = false;
            }
        } else {
            // Not in a type definition, just add the line (could be comments, etc.)
            result.push(line + '\n');
        }
    }
    
    // Handle last type if file doesn't end with closing brace
    if (inTypeDefinition && currentTypeName && !definedTypes.has(currentTypeName)) {
        result.push(currentType);
        definedTypes.add(currentTypeName);
    }

    return result.join('');
}

function generateFilterInput(archetypeName: string, zodSchema: any): string {
    // Generate filter input with common filter operators
    // Add a dummy field to make the input type valid until full implementation
    return `
input ${archetypeName}Filter {
  id: ID
  _placeholder: String
}

`;
}

function generateCreateInput(archetypeName: string, zodSchema: any): string {
    // Generate create input (all fields except id)
    // Add a dummy field to make the input type valid until full implementation
    return `
input Create${archetypeName}Input {
  _placeholder: String
}

`;
}

function generateUpdateInput(archetypeName: string, zodSchema: any): string {
    // Generate update input (all fields optional except id)
    // Add a dummy field to make the input type valid until full implementation
    return `
input Update${archetypeName}Input {
  _placeholder: String
}

`;
}

// Resolver creators
function createGetResolver(archetypeName: string) {
    return async (_: any, { id }: { id: string }, context: any) => {
        // TODO: Implement actual entity fetching
        logger.trace(`Getting ${archetypeName} with id: ${id}`);
        throw new Error(`get${archetypeName} resolver not implemented`);
    };
}

function createListResolver(archetypeName: string) {
    return async (_: any, { filter, limit, offset }: any, context: any) => {
        // TODO: Implement actual entity querying
        logger.trace(`Listing ${archetypeName}s with filter:`, filter);
        throw new Error(`list${archetypeName}s resolver not implemented`);
    };
}

function createCreateResolver(archetypeName: string) {
    return async (_: any, { input }: any, context: any) => {
        // TODO: Implement actual entity creation
        logger.trace(`Creating ${archetypeName} with input:`, input);
        throw new Error(`create${archetypeName} resolver not implemented`);
    };
}

function createUpdateResolver(archetypeName: string) {
    return async (_: any, { id, input }: any, context: any) => {
        // TODO: Implement actual entity update
        logger.trace(`Updating ${archetypeName} ${id} with input:`, input);
        throw new Error(`update${archetypeName} resolver not implemented`);
    };
}

function createDeleteResolver(archetypeName: string) {
    return async (_: any, { id }: { id: string }, context: any) => {
        // TODO: Implement actual entity deletion
        logger.trace(`Deleting ${archetypeName} with id: ${id}`);
        throw new Error(`delete${archetypeName} resolver not implemented`);
    };
}
