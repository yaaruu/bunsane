import type { SQL } from "bun";

export interface IEntity {
    save(trx?: SQL): Promise<boolean>;
    doDelete(force?: boolean): Promise<boolean>;
}