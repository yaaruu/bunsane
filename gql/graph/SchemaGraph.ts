import { GraphNode, NodeType } from './GraphNode';

/**
 * Directed graph data structure for managing GraphQL schema components and their dependencies.
 * Provides topological sorting and dependency resolution for schema generation.
 */
export class SchemaGraph {
    private nodes: Map<string, GraphNode> = new Map();
    private adjacencyList: Map<string, Set<string>> = new Map(); // nodeId -> set of dependent nodeIds

    /**
     * Add a node to the graph
     */
    addNode(node: GraphNode): void {
        if (this.nodes.has(node.id)) {
            throw new Error(`Node with id '${node.id}' already exists in graph`);
        }

        this.nodes.set(node.id, node);
        this.adjacencyList.set(node.id, new Set());

        // Add reverse edges for dependencies (what depends on this node)
        for (const depId of node.dependencies) {
            if (!this.adjacencyList.has(depId)) {
                this.adjacencyList.set(depId, new Set());
            }
            this.adjacencyList.get(depId)!.add(node.id);
        }
    }

    /**
     * Get a node by its ID
     */
    getNode(nodeId: string): GraphNode | undefined {
        return this.nodes.get(nodeId);
    }

    /**
     * Check if a node exists in the graph
     */
    hasNode(nodeId: string): boolean {
        return this.nodes.has(nodeId);
    }

    /**
     * Remove a node from the graph
     */
    removeNode(nodeId: string): boolean {
        const node = this.nodes.get(nodeId);
        if (!node) {
            return false;
        }

        // Remove from nodes map
        this.nodes.delete(nodeId);

        // Remove from adjacency list
        this.adjacencyList.delete(nodeId);

        // Remove this node from other nodes' dependency lists
        for (const [otherNodeId, dependents] of this.adjacencyList) {
            dependents.delete(nodeId);
        }

        return true;
    }

    /**
     * Get all nodes in the graph
     */
    getAllNodes(): GraphNode[] {
        return Array.from(this.nodes.values());
    }

    /**
     * Get nodes of a specific type
     */
    getNodesByType(nodeType: NodeType): GraphNode[] {
        return this.getAllNodes().filter(node => node.nodeType === nodeType);
    }

    /**
     * Get direct dependencies of a node (nodes this node depends on)
     */
    getDependencies(nodeId: string): GraphNode[] {
        const node = this.getNode(nodeId);
        if (!node) {
            return [];
        }

        return node.dependencies
            .map(depId => this.getNode(depId))
            .filter((dep): dep is GraphNode => dep !== undefined);
    }

    /**
     * Get nodes that depend on the given node (reverse dependencies)
     */
    getDependents(nodeId: string): GraphNode[] {
        const dependents = this.adjacencyList.get(nodeId);
        if (!dependents) {
            return [];
        }

        return Array.from(dependents)
            .map(depId => this.getNode(depId))
            .filter((dep): dep is GraphNode => dep !== undefined);
    }

    /**
     * Add a dependency edge between two nodes
     */
    addDependency(fromNodeId: string, toNodeId: string): void {
        const fromNode = this.getNode(fromNodeId);
        const toNode = this.getNode(toNodeId);

        if (!fromNode) {
            throw new Error(`Source node '${fromNodeId}' does not exist`);
        }
        if (!toNode) {
            throw new Error(`Target node '${toNodeId}' does not exist`);
        }

        fromNode.addDependency(toNodeId);

        // Update adjacency list for reverse lookup
        if (!this.adjacencyList.has(toNodeId)) {
            this.adjacencyList.set(toNodeId, new Set());
        }
        this.adjacencyList.get(toNodeId)!.add(fromNodeId);
    }

    /**
     * Remove a dependency edge between two nodes
     */
    removeDependency(fromNodeId: string, toNodeId: string): void {
        const fromNode = this.getNode(fromNodeId);
        if (!fromNode) {
            return;
        }

        fromNode.removeDependency(toNodeId);

        // Update adjacency list
        const dependents = this.adjacencyList.get(toNodeId);
        if (dependents) {
            dependents.delete(fromNodeId);
        }
    }

    /**
     * Perform topological sort of the graph
     * Returns nodes in dependency order (dependencies first)
     */
    topologicalSort(): GraphNode[] {
        const visited = new Set<string>();
        const visiting = new Set<string>(); // For cycle detection
        const result: GraphNode[] = [];

        const visit = (nodeId: string): void => {
            if (visited.has(nodeId)) {
                return;
            }

            if (visiting.has(nodeId)) {
                throw new Error(`Cycle detected in graph involving node '${nodeId}'`);
            }

            visiting.add(nodeId);

            // Visit all dependencies first
            const node = this.getNode(nodeId);
            if (node) {
                for (const depId of node.dependencies) {
                    if (this.hasNode(depId)) {
                        visit(depId);
                    }
                }
            }

            visiting.delete(nodeId);
            visited.add(nodeId);

            if (node) {
                result.push(node);
            }
        };

        // Visit all nodes
        for (const nodeId of this.nodes.keys()) {
            if (!visited.has(nodeId)) {
                visit(nodeId);
            }
        }

        return result;
    }

    /**
     * Get nodes in dependency order (topologically sorted)
     */
    getNodesInDependencyOrder(): GraphNode[] {
        return this.topologicalSort();
    }

    /**
     * Clear all nodes and edges from the graph
     */
    clear(): void {
        this.nodes.clear();
        this.adjacencyList.clear();
    }

    /**
     * Get graph statistics
     */
    getStats(): {
        nodeCount: number;
        edgeCount: number;
        nodesByType: Record<NodeType, number>;
    } {
        const nodesByType = Object.values(NodeType).reduce((acc, type) => {
            acc[type] = 0;
            return acc;
        }, {} as Record<NodeType, number>);

        for (const node of this.nodes.values()) {
            nodesByType[node.nodeType]++;
        }

        let edgeCount = 0;
        for (const node of this.nodes.values()) {
            edgeCount += node.dependencies.length;
        }

        return {
            nodeCount: this.nodes.size,
            edgeCount,
            nodesByType
        };
    }

    /**
     * Validate the graph structure
     * Checks for missing dependencies and other consistency issues
     */
    validate(): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        for (const [nodeId, node] of this.nodes) {
            // Check that all dependencies exist
            for (const depId of node.dependencies) {
                if (!this.hasNode(depId)) {
                    errors.push(`Node '${nodeId}' depends on non-existent node '${depId}'`);
                }
            }
        }

        // Check for cycles (this will throw an error if cycles exist)
        try {
            this.topologicalSort();
        } catch (error) {
            errors.push(`Graph contains cycles: ${(error as Error).message}`);
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Get the number of nodes in the graph
     */
    size(): number {
        return this.nodes.size;
    }
}