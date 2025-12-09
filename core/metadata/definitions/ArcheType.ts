export interface ArcheTypeMetadata {
    name: string;
    target: Function;
    typeId: string;
    functions?: ArcheTypeFunctionMetadata[];
}

export interface ArcheTypeFunctionMetadata {
    propertyKey: string;
    options?: { returnType?: string };
}

export interface ArcheTypeFieldOptions {
    nullable?: boolean;
    filterable?: boolean;
}
