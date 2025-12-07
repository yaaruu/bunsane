import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";
import { TypeDefBuilder } from "../builders/TypeDefBuilder";
import { InputTypeBuilder } from "../builders/InputTypeBuilder";

/**
 * Visitor that generates the final GraphQL schema typeDefs string.
 * Uses the TypeDefBuilder and InputTypeBuilder from Phase 4 to construct the schema.
 */
export class SchemaGeneratorVisitor extends GraphVisitor {
    private typeDefBuilder: TypeDefBuilder;
    private inputTypeBuilder: InputTypeBuilder;
    private scalarTypes: Set<string> = new Set();

    constructor() {
        super();
        this.typeDefBuilder = new TypeDefBuilder();
        this.inputTypeBuilder = new InputTypeBuilder();
    }

    visitTypeNode(node: TypeNode): void {
        // TypeNodes represent object types that are already defined
        // These would typically come from archetype schemas
        // For now, we'll collect them but not add them to the builders
        // as they should be handled separately
    }

    visitOperationNode(node: OperationNode): void {
        // Add operation fields to the appropriate builders
        const field = {
            name: node.name,
            fieldDef: node.fieldDef
        };

        switch (node.operationType) {
            case 'QUERY':
                this.typeDefBuilder.addQueryField(field);
                break;
            case 'MUTATION':
                this.typeDefBuilder.addMutationField(field);
                break;
            case 'SUBSCRIPTION':
                this.typeDefBuilder.addSubscriptionField(field);
                break;
        }
    }

    visitFieldNode(node: FieldNode): void {
        // FieldNodes represent individual field resolvers
        // These are typically part of object types, not operation types
        // For now, we'll skip these as they're handled by archetypes
    }

    visitInputNode(node: InputNode): void {
        // Add input types to the input type builder
        const typeDef = {
            name: node.name,
            fields: this.parseInputFields(node.typeDef)
        };
        this.inputTypeBuilder.addInputType(typeDef);
    }

    visitScalarNode(node: ScalarNode): void {
        this.scalarTypes.add(node.name);
    }

    getResults(): {
        typeDefs: string;
        inputTypes: string;
        scalarTypes: string[];
    } {
        const typeDefs = this.typeDefBuilder.buildAllOperationTypes();
        const inputTypes = this.inputTypeBuilder.buildInputTypes();

        return {
            typeDefs,
            inputTypes,
            scalarTypes: Array.from(this.scalarTypes)
        };
    }

    /**
     * Get the complete schema typeDefs string
     */
    getSchemaTypeDefs(): string {
        const results = this.getResults();
        let schema = '';

        // Add scalar definitions
        for (const scalar of results.scalarTypes) {
            schema += `scalar ${scalar}\n`;
        }

        // Add input types
        if (results.inputTypes) {
            schema += results.inputTypes + '\n';
        }

        // Add operation types
        if (results.typeDefs) {
            schema += results.typeDefs + '\n';
        }

        return schema.trim();
    }

    /**
     * Parse input type definition to extract field strings
     * This is a simple parser for input type definitions
     */
    private parseInputFields(typeDef: string): string[] {
        const lines = typeDef.split('\n');
        const fields: string[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('input') && !trimmed.startsWith('}')) {
                fields.push(trimmed);
            }
        }

        return fields;
    }

    /**
     * Clear all builders and data
     */
    clear(): void {
        this.typeDefBuilder.clear();
        this.inputTypeBuilder.clear();
        this.scalarTypes.clear();
    }
}