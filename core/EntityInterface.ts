export interface IEntity {
    doSave(): Promise<boolean>;
    doDelete(force?: boolean): Promise<boolean>;
}