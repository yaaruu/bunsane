import { QueryNode } from "./QueryNode";
import type { QueryResult } from "./QueryNode";
import { QueryContext } from "./QueryContext";
import { SourceNode } from "./SourceNode";
import { ComponentInclusionNode } from "./ComponentInclusionNode";

export class QueryDAG {
    private nodes: QueryNode[] = [];
    private rootNode: QueryNode | null = null;

    public addNode(node: QueryNode): void {
        if (!this.nodes.includes(node)) {
            this.nodes.push(node);
        }
    }

    public setRootNode(node: QueryNode): void {
        this.rootNode = node;
        this.addNode(node);
    }

    public getRootNode(): QueryNode | null {
        return this.rootNode;
    }

    public getNodes(): QueryNode[] {
        return [...this.nodes];
    }

    /**
     * Execute the DAG by finding and executing the final node in the chain
     */
    public execute(context: QueryContext): QueryResult {
        if (!this.rootNode) {
            throw new Error("No root node set in QueryDAG");
        }

        // Get all nodes in topological order
        const allNodes = this.rootNode.getTopologicalOrder();
        
        // The leaf node is the one that no other node depends on
        // Find it by checking which nodes are not in any node's dependencies
        const nodesInDependencies = new Set<QueryNode>();
        for (const node of allNodes) {
            for (const dep of node.getDependencies()) {
                nodesInDependencies.add(dep);
            }
        }
        
        const leafNodes = allNodes.filter(node => !nodesInDependencies.has(node));
        
        if (leafNodes.length === 0) {
            throw new Error("No leaf node found in DAG");
        }
        
        // If multiple leaf nodes, take the last one in topological order
        const leafNode = leafNodes[leafNodes.length - 1]!;

        // Execute only the leaf node - it will get results from its dependencies
        const result = leafNode.execute(context);

        return result;
    }

    /**
     * Build a basic DAG for component-based queries
     */
    public static buildBasicQuery(context: QueryContext): QueryDAG {
        const dag = new QueryDAG();

        // Create source node
        const sourceNode = new SourceNode();
        dag.setRootNode(sourceNode);

        // If we have component requirements, add component inclusion node
        if (context.componentIds.size > 0 || context.excludedComponentIds.size > 0) {
            const componentNode = new ComponentInclusionNode();
            componentNode.addDependency(sourceNode);
            dag.addNode(componentNode);
        }

        return dag;
    }
}