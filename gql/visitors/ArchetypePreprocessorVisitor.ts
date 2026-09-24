import { GraphVisitor } from "./GraphVisitor";
import { TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";

/**
 * Visitor that records archetype type nodes. Schema SDL is woven once by
 * SchemaGeneratorVisitor — this visitor must not weave and discard the string.
 */
export class ArchetypePreprocessorVisitor extends GraphVisitor {
    private processedArchetypes: Set<string> = new Set();

    visitTypeNode(node: TypeNode): void {
        if (node.metadata.isArchetype) {
            this.processedArchetypes.add(node.name);
        }
    }

    visitOperationNode(_node: OperationNode): void {}

    visitFieldNode(_node: FieldNode): void {}

    visitInputNode(_node: InputNode): void {}

    visitScalarNode(_node: ScalarNode): void {}

    getResults(): {
        processedArchetypes: string[];
        archetypeSchemas: never[];
    } {
        return {
            processedArchetypes: Array.from(this.processedArchetypes),
            archetypeSchemas: [],
        };
    }

    isArchetypeProcessed(archetypeName: string): boolean {
        return this.processedArchetypes.has(archetypeName);
    }

    getProcessedArchetypes(): string[] {
        return Array.from(this.processedArchetypes);
    }

    clear(): void {
        this.processedArchetypes.clear();
    }
}
