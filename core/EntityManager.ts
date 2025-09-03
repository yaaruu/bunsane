import ApplicationLifecycle, { ApplicationPhase } from "./ApplicationLifecycle";
import type { Entity } from "./Entity";

class EntityManager {
    static #instance: EntityManager;
    private dbReady = false;
    private entityQueue: Entity[] = [];

    constructor() {
        ApplicationLifecycle.addPhaseListener(async (event) => {
            if (event.detail === ApplicationPhase.DATABASE_READY) {
                this.dbReady = true;
                await this.savePendingEntities();
            }
        });
    }

    public saveEntity(entity: Entity) {
        return new Promise<boolean>(async resolve => {
            if(!this.dbReady) {
                this.entityQueue.push(entity);
                return resolve(true);
            } else {
                resolve(entity.doSave());
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