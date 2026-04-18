import ApplicationLifecycle, { ApplicationPhase, type PhaseChangeEvent } from "./ApplicationLifecycle";
import type { IEntity } from "./EntityInterface";

class EntityManager {
    static #instance: EntityManager;
    private dbReady = false;
    private entityQueue: IEntity[] = [];
    private phaseListener: ((event: PhaseChangeEvent) => void) | null = null;

    constructor() {
        this.phaseListener = async (event: PhaseChangeEvent) => {
            if (event.detail === ApplicationPhase.DATABASE_READY) {
                this.dbReady = true;
                await this.savePendingEntities();
            }
        };
        ApplicationLifecycle.addPhaseListener(this.phaseListener);
    }

    public dispose(): void {
        if (this.phaseListener) {
            ApplicationLifecycle.removePhaseListener(this.phaseListener);
            this.phaseListener = null;
        }
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
           promiseWait.push(entity.save()); 
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