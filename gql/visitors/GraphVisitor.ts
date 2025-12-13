import { GraphNode, TypeNode, OperationNode, FieldNode, InputNode, ScalarNode } from "../graph/GraphNode";

/**
 * Base visitor class for traversing GraphQL schema graphs.
 * Implements the Visitor pattern to separate algorithms from data structures.
 *
 * Each concrete visitor implements specific behavior for different node types.
 */
export abstract class GraphVisitor {
    /**
     * Visit a generic graph node
     */
    visit(node: GraphNode): void {
        switch (node.nodeType) {
            case 'TYPE':
                this.visitTypeNode(node as TypeNode);
                break;
            case 'OPERATION':
                this.visitOperationNode(node as OperationNode);
                break;
            case 'FIELD':
                this.visitFieldNode(node as FieldNode);
                break;
            case 'INPUT':
                this.visitInputNode(node as InputNode);
                break;
            case 'SCALAR':
                this.visitScalarNode(node as ScalarNode);
                break;
            default:
                throw new Error(`Unknown node type: ${(node as any).nodeType}`);
        }
    }

    /**
     * Visit a TypeNode
     */
    abstract visitTypeNode(node: TypeNode): void;

    /**
     * Visit an OperationNode
     */
    abstract visitOperationNode(node: OperationNode): void;

    /**
     * Visit a FieldNode
     */
    abstract visitFieldNode(node: FieldNode): void;

    /**
     * Visit an InputNode
     */
    abstract visitInputNode(node: InputNode): void;

    /**
     * Visit a ScalarNode
     */
    abstract visitScalarNode(node: ScalarNode): void;

    /**
     * Called before visiting a graph to perform setup
     */
    beforeVisit(): void {
        // Default: no-op
    }

    /**
     * Called after visiting a graph to perform cleanup or finalization
     */
    afterVisit(): void {
        // Default: no-op
    }

    /**
     * Get the results of the visitation
     */
    abstract getResults(): any;
}