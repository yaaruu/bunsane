export interface ComponentMetadata {
    name: string;
    typeId: string;
    target: Function;
}

export interface ComponentPropertyMetadata {
    propertyKey: string;
    propertyType?: any;
    component_id: string;
    indexed: boolean;
    isPrimitive: boolean;
    isEnum: boolean;
    enumValues?: string[];
    enumKeys?: string[];
    isOptional: boolean;
    arrayOf?: any;
}

export interface IndexedFieldMetadata {
    componentId: string;
    propertyKey: string;
    indexType: 'gin' | 'btree' | 'hash';
    isDateField: boolean;
}