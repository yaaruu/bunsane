import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";

/**
 * Visitor that collects all type definitions in dependency order.
 * Used to gather type definitions before schema generation.
 */
export class TypeCollectorVisitor extends GraphVisitor {
    private collectedTypes: Map<string, string> = new Map();
    private collectedInputs: Map<string, string> = new Map();
    private collectedScalars: Set<string> = new Set();

    visitTypeNode(node: TypeNode): void {
        this.collectedTypes.set(node.name, node.typeDef);
    }

    visitOperationNode(node: OperationNode): void {
        // Operations don't define types themselves, but may reference them
        // This visitor focuses on collecting type definitions
    }

    visitFieldNode(node: FieldNode): void {
        // Fields don't define types themselves
    }

    visitInputNode(node: InputNode): void {
        this.collectedInputs.set(node.name, node.typeDef);
    }

    visitScalarNode(node: ScalarNode): void {
        this.collectedScalars.add(node.name);
    }

    getResults(): {
        types: Map<string, string>;
        inputs: Map<string, string>;
        scalars: Set<string>;
    } {
        return {
            types: new Map(this.collectedTypes),
            inputs: new Map(this.collectedInputs),
            scalars: new Set(this.collectedScalars)
        };
    }

    /**
     * Get all type definitions as a single string in dependency order
     */
    getTypeDefsString(): string {
        const results = this.getResults();
        let typeDefs = '';

        // Add scalar definitions first
        for (const scalarName of results.scalars) {
            typeDefs += `scalar ${scalarName}\n`;
        }

        // Add input types
        for (const [name, typeDef] of results.inputs) {
            typeDefs += `${typeDef}\n`;
        }

        // Add object types
        for (const [name, typeDef] of results.types) {
            typeDefs += `${typeDef}\n`;
        }

        return typeDefs.trim();
    }

    /**
     * Clear all collected types
     */
    clear(): void {
        this.collectedTypes.clear();
        this.collectedInputs.clear();
        this.collectedScalars.clear();
    }
}