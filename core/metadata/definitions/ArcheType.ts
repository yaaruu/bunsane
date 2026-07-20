export interface ArcheTypeMetadata {
    name: string;
    target: Function;
    typeId: string;
    functions?: ArcheTypeFunctionMetadata[];
    componentNames?: string[];   // component class names of this archetype's @ArcheTypeField set (P1 QSP)
}

export interface ArcheTypeFunctionMetadata {
    propertyKey: string;
    options?: { 
        returnType?: string;
        args?: Array<{ 
            name: string; 
            type: any; 
            nullable?: boolean;
        }>;
    };
}

export interface ArcheTypeFieldOptions {
    nullable?: boolean;
    filterable?: boolean;
}
