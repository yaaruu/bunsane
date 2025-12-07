import { GraphVisitor } from "./GraphVisitor";
import { SchemaGraph } from "../graph/SchemaGraph";

/**
 * Composes multiple visitors to run them in sequence on a graph.
 * Allows chaining visitor operations for complex processing pipelines.
 */
export class VisitorComposer {
    private visitors: GraphVisitor[] = [];

    /**
     * Add a visitor to the composition
     */
    addVisitor(visitor: GraphVisitor): VisitorComposer {
        this.visitors.push(visitor);
        return this;
    }

    /**
     * Run all visitors on the given graph in sequence
     */
    visitGraph(graph: SchemaGraph): Record<string, any> {
        for (const visitor of this.visitors) {
            // Call beforeVisit for setup
            visitor.beforeVisit();

            // Visit all nodes in topological order
            const sortedNodes = graph.topologicalSort();
            for (const node of sortedNodes) {
                visitor.visit(node);
            }

            // Call afterVisit for cleanup
            visitor.afterVisit();
        }

        return this.getResults();
    }

    /**
     * Run all visitors on a specific set of nodes
     */
    visitNodes(nodes: any[]): Record<string, any> {
        for (const visitor of this.visitors) {
            for (const node of nodes) {
                visitor.visit(node);
            }
        }

        return this.getResults();
    }

    /**
     * Remove a specific visitor from the composition
     */
    removeVisitor(visitor: GraphVisitor): boolean {
        const index = this.visitors.indexOf(visitor);
        if (index > -1) {
            this.visitors.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Clear all visitors from the composer
     */
    clearVisitors(): void {
        this.visitors = [];
    }

    /**
     * Get results from all visitors as an object
     */
    getResults(): Record<string, any> {
        const results: Record<string, any> = {};
        this.visitors.forEach((visitor, index) => {
            results[`visitor-${index}`] = visitor.getResults();
        });
        return results;
    }

    /**
     * Get the number of visitors in the composition
     */
    size(): number {
        return this.visitors.length;
    }

    /**
     * Get all visitors in the composition
     */
    getVisitors(): GraphVisitor[] {
        return [...this.visitors];
    }
}