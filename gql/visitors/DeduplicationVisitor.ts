import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";

/**
 * Visitor that tracks and eliminates duplicate type definitions.
 * Ensures that each type name is defined only once in the schema.
 */
export class DeduplicationVisitor extends GraphVisitor {
    private seenTypeNames: Set<string> = new Set();
    private duplicateNodes: Set<string> = new Set(); // Node IDs that are duplicates

    visitTypeNode(node: TypeNode): void {
        if (this.seenTypeNames.has(node.name)) {
            this.duplicateNodes.add(node.id);
        } else {
            this.seenTypeNames.add(node.name);
        }
    }

    visitOperationNode(node: OperationNode): void {
        // Operations don't define new types, so no deduplication needed
    }

    visitFieldNode(node: FieldNode): void {
        // Fields don't define new types
    }

    visitInputNode(node: InputNode): void {
        if (this.seenTypeNames.has(node.name)) {
            this.duplicateNodes.add(node.id);
        } else {
            this.seenTypeNames.add(node.name);
        }
    }

    visitScalarNode(node: ScalarNode): void {
        if (this.seenTypeNames.has(node.name)) {
            this.duplicateNodes.add(node.id);
        } else {
            this.seenTypeNames.add(node.name);
        }
    }

    getResults(): {
        duplicateNodeIds: Set<string>;
        uniqueTypeNames: Set<string>;
    } {
        return {
            duplicateNodeIds: new Set(this.duplicateNodes),
            uniqueTypeNames: new Set(this.seenTypeNames)
        };
    }

    /**
     * Check if a node ID is a duplicate
     */
    isDuplicate(nodeId: string): boolean {
        return this.duplicateNodes.has(nodeId);
    }

    /**
     * Get all duplicate node IDs
     */
    getDuplicateNodeIds(): string[] {
        return Array.from(this.duplicateNodes);
    }

    /**
     * Get all unique type names seen
     */
    getUniqueTypeNames(): string[] {
        return Array.from(this.seenTypeNames);
    }

    /**
     * Clear all tracking data
     */
    clear(): void {
        this.seenTypeNames.clear();
        this.duplicateNodes.clear();
    }
}