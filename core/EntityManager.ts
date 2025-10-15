import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";
import type { IEntity } from "./EntityInterface";

class EntityManager {
    static #instance: EntityManager;
    private dbReady = false;
    private entityQueue: IEntity[] = [];

    constructor() {
        ApplicationLifecycle.addPhaseListener(async (event) => {
            if (event.detail === ApplicationPhase.DATABASE_READY) {
                this.dbReady = true;
                await this.savePendingEntities();
            }
        });
    }

    public saveEntity(entity: IEntity) {
        return new Promise<boolean>(async resolve => {
            if(!this.dbReady) {
                this.entityQueue.push(entity);
                return resolve(true);
            } else {
                const result = await entity.doSave();
                resolve(result);
            }
        })
    }

    public deleteEntity(entity: IEntity, force: boolean = false) {
        return new Promise<boolean>(async resolve => {
            if(!this.dbReady) {
                return resolve(false);
            } else {
                resolve(entity.doDelete(force));
            }
        })
    }

    private async savePendingEntities() {
        const promiseWait = [];
        for(const entity of this.entityQueue) {
           promiseWait.push(entity.doSave()); 
        }
        return await Promise.all(promiseWait);
    }

    public static get instance(): EntityManager {
        if (!this.#instance) {
            this.#instance = new EntityManager();
        }
        return this.#instance;
    }
}

export default EntityManager.instance;