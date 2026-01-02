interface BaseComponent {

}
export type ComponentDataType<T extends BaseComponent> = {
    [K in keyof T as T[K] extends Function ? never : 
                    K extends `_${string}` ? never : 
                    K extends 'id' | 'getTypeID' | 'properties' | 'data' | 'save' | 'insert' | 'update' ? never : 
                    K]: T[K];
};