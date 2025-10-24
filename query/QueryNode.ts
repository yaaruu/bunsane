import { QueryContext } from "./QueryContext";

export interface QueryResult {
    sql: string;
    params: any[];
    context: QueryContext;
}

export abstract class QueryNode {
    protected dependencies: QueryNode[] = [];
    protected dependents: QueryNode[] = [];

    public addDependency(node: QueryNode): void {
        if (!this.dependencies.includes(node)) {
            this.dependencies.push(node);
            node.addDependent(this);
        }
    }

    public addDependent(node: QueryNode): void {
        if (!this.dependents.includes(node)) {
            this.dependents.push(node);
        }
    }

    public getDependencies(): QueryNode[] {
        return [...this.dependencies];
    }

    public getDependents(): QueryNode[] {
        return [...this.dependents];
    }

    public abstract execute(context: QueryContext): QueryResult;

    public abstract getNodeType(): string;

    /**
     * Get all nodes in topological order (dependencies first)
     */
    public getTopologicalOrder(visited: Set<QueryNode> = new Set(), result: QueryNode[] = []): QueryNode[] {
        if (visited.has(this)) {
            return result;
        }

        visited.add(this);

        // Visit all dependencies first
        for (const dep of this.dependencies) {
            dep.getTopologicalOrder(visited, result);
        }

        // Then add this node
        if (!result.includes(this)) {
            result.push(this);
        }

        // Then visit all dependents (nodes that depend on this)
        for (const dependent of this.dependents) {
            dependent.getTopologicalOrder(visited, result);
        }

        return result;
    }
}