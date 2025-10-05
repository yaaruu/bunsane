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
    return match ? match[1] : null;
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

function generateFilterInput(archetypeName: string, zodSchema: any): string {
    // Generate filter input with common filter operators
    return `
input ${archetypeName}Filter {
  id: ID
  # Add more filter fields based on archetype properties
  # TODO: Auto-generate from zodSchema properties
}

`;
}

function generateCreateInput(archetypeName: string, zodSchema: any): string {
    // Generate create input (all fields except id)
    return `
input Create${archetypeName}Input {
  # Auto-generated from archetype schema
  # TODO: Extract from zodSchema and make required fields non-nullable
}

`;
}

function generateUpdateInput(archetypeName: string, zodSchema: any): string {
    // Generate update input (all fields optional except id)
    return `
input Update${archetypeName}Input {
  # Auto-generated from archetype schema
  # TODO: Extract from zodSchema and make all fields optional
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
