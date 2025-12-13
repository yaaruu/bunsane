import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";
import { weaveAllArchetypes, getAllArchetypeSchemas } from "../../core/ArcheType";

/**
 * Visitor that pre-processes archetype schemas before other visitors run.
 * Ensures all archetype GraphQL schemas are generated and cached.
 */
export class ArchetypePreprocessorVisitor extends GraphVisitor {
    private processedArchetypes: Set<string> = new Set();
    private archetypeSchemas: any[] = [];

    beforeVisit(): void {
        // Pre-weave all archetypes to ensure schemas are generated
        try {
            const schema = weaveAllArchetypes();
            if (schema) {
                this.archetypeSchemas = getAllArchetypeSchemas();
            }
        } catch (error) {
            console.warn("Failed to pre-process archetype schemas:", error);
        }
    }

    visitTypeNode(node: TypeNode): void {
        // Check if this is an archetype type
        if (node.metadata.isArchetype) {
            this.processedArchetypes.add(node.name);
        }
    }

    visitOperationNode(node: OperationNode): void {
        // Operations may reference archetype types
        // We don't need to do anything special here
    }

    visitFieldNode(node: FieldNode): void {
        // Fields may be part of archetype types
    }

    visitInputNode(node: InputNode): void {
        // Input nodes don't need archetype preprocessing
    }

    visitScalarNode(node: ScalarNode): void {
        // Scalar nodes don't need archetype preprocessing
    }

    getResults(): {
        processedArchetypes: string[];
        archetypeSchemas: any[];
    } {
        return {
            processedArchetypes: Array.from(this.processedArchetypes),
            archetypeSchemas: [...this.archetypeSchemas]
        };
    }

    /**
     * Check if an archetype has been processed
     */
    isArchetypeProcessed(archetypeName: string): boolean {
        return this.processedArchetypes.has(archetypeName);
    }

    /**
     * Get all processed archetype names
     */
    getProcessedArchetypes(): string[] {
        return Array.from(this.processedArchetypes);
    }

    /**
     * Clear all processed data
     */
    clear(): void {
        this.processedArchetypes.clear();
        this.archetypeSchemas = [];
    }
}