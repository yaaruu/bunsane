import type { SQL } from "bun";

export interface IEntity {
    doSave(trx: SQL): Promise<boolean>;
    doDelete(force?: boolean): Promise<boolean>;
}