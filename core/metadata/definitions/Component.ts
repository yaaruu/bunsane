export interface ComponentMetadata {
    name: string;
    typeId: string;
    target: Function;
}

export interface ComponentPropertyMetadata {
    propertyKey: string;
    component_id: string;
    indexed: boolean;
}