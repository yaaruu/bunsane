/**
 * Core graph data structures for GraphQL schema generation.
 * Following Gall's Law: Start with a simple system that works.
 */

export enum NodeType {
    TYPE = 'TYPE',
    OPERATION = 'OPERATION',
    FIELD = 'FIELD',
    INPUT = 'INPUT',
    SCALAR = 'SCALAR'
}

export enum GraphQLTypeKind {
    SCALAR = 'SCALAR',
    OBJECT = 'OBJECT',
    INTERFACE = 'INTERFACE',
    UNION = 'UNION',
    ENUM = 'ENUM',
    INPUT_OBJECT = 'INPUT_OBJECT'
}

export enum OperationType {
    QUERY = 'QUERY',
    MUTATION = 'MUTATION',
    SUBSCRIPTION = 'SUBSCRIPTION'
}

/**
 * Base class for all graph nodes in the GraphQL schema generation system.
 * Each node represents a component of the GraphQL schema with its dependencies.
 */
export abstract class GraphNode {
    public readonly id: string;
    public readonly nodeType: NodeType;
    public readonly metadata: Record<string, any>;
    public readonly dependencies: string[]; // Array of node IDs this node depends on

    constructor(
        id: string,
        nodeType: NodeType,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        this.id = id;
        this.nodeType = nodeType;
        this.metadata = { ...metadata };
        this.dependencies = [...dependencies];
    }

    /**
     * Get a human-readable description of this node
     */
    abstract getDescription(): string;

    /**
     * Check if this node depends on another node
     */
    dependsOn(nodeId: string): boolean {
        return this.dependencies.includes(nodeId);
    }

    /**
     * Add a dependency to this node
     */
    addDependency(nodeId: string): void {
        if (!this.dependencies.includes(nodeId)) {
            this.dependencies.push(nodeId);
        }
    }

    /**
     * Remove a dependency from this node
     */
    removeDependency(nodeId: string): void {
        const index = this.dependencies.indexOf(nodeId);
        if (index > -1) {
            this.dependencies.splice(index, 1);
        }
    }
}

/**
 * Represents a GraphQL type definition (scalar, object, interface, union, enum)
 */
export class TypeNode extends GraphNode {
    public readonly kind: GraphQLTypeKind;
    public readonly name: string;
    public readonly typeDef: string; // GraphQL type definition string

    constructor(
        id: string,
        name: string,
        kind: GraphQLTypeKind,
        typeDef: string,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        super(id, NodeType.TYPE, metadata, dependencies);
        this.name = name;
        this.kind = kind;
        this.typeDef = typeDef;
    }

    getDescription(): string {
        return `Type ${this.name} (${this.kind})`;
    }
}

/**
 * Represents a GraphQL operation (Query, Mutation, Subscription)
 */
export class OperationNode extends GraphNode {
    public readonly operationType: OperationType;
    public readonly name: string;
    public readonly fieldDef: string; // GraphQL field definition string
    public readonly inputNodeId?: string; // ID of input node if any
    public readonly outputNodeId?: string; // ID of output node if any

    constructor(
        id: string,
        operationType: OperationType,
        name: string,
        fieldDef: string,
        inputNodeId?: string,
        outputNodeId?: string,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        super(id, NodeType.OPERATION, metadata, dependencies);
        this.operationType = operationType;
        this.name = name;
        this.fieldDef = fieldDef;
        this.inputNodeId = inputNodeId;
        this.outputNodeId = outputNodeId;

        // Auto-add dependencies based on input/output nodes
        if (inputNodeId && !dependencies.includes(inputNodeId)) {
            this.addDependency(inputNodeId);
        }
        if (outputNodeId && !dependencies.includes(outputNodeId)) {
            this.addDependency(outputNodeId);
        }
    }

    getDescription(): string {
        return `${this.operationType} operation ${this.name}`;
    }
}

/**
 * Represents a GraphQL field resolver
 */
export class FieldNode extends GraphNode {
    public readonly typeName: string; // The type this field belongs to
    public readonly fieldName: string;
    public readonly fieldDef: string; // GraphQL field definition string

    constructor(
        id: string,
        typeName: string,
        fieldName: string,
        fieldDef: string,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        super(id, NodeType.FIELD, metadata, dependencies);
        this.typeName = typeName;
        this.fieldName = fieldName;
        this.fieldDef = fieldDef;
    }

    getDescription(): string {
        return `Field ${this.fieldName} on type ${this.typeName}`;
    }
}

/**
 * Represents a GraphQL input type definition
 */
export class InputNode extends GraphNode {
    public readonly name: string;
    public readonly typeDef: string; // GraphQL input type definition string
    public readonly isOptional: boolean; // Whether this input is optional

    constructor(
        id: string,
        name: string,
        typeDef: string,
        isOptional: boolean = false,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        super(id, NodeType.INPUT, metadata, dependencies);
        this.name = name;
        this.typeDef = typeDef;
        this.isOptional = isOptional;
    }

    getDescription(): string {
        return `Input type ${this.name}${this.isOptional ? ' (optional)' : ''}`;
    }
}

/**
 * Represents a GraphQL scalar type
 */
export class ScalarNode extends GraphNode {
    public readonly name: string;

    constructor(
        id: string,
        name: string,
        metadata: Record<string, any> = {},
        dependencies: string[] = []
    ) {
        super(id, NodeType.SCALAR, metadata, dependencies);
        this.name = name;
    }

    getDescription(): string {
        return `Scalar type ${this.name}`;
    }
}