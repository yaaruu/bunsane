import ApplicationLifecycle, { ApplicationPhase, type PhaseChangeEvent } from "./ApplicationLifecycle";
import type { IEntity } from "./EntityInterface";

class EntityManager {
    static #instance: EntityManager;
    private entityQueue: IEntity[] = [];
    private phaseListener: ((event: PhaseChangeEvent) => void) | null = null;

    constructor() {
        this.phaseListener = async (event: PhaseChangeEvent) => {
            if (event.detail === ApplicationPhase.DATABASE_READY) {
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

    /**
     * Delete is delegated straight to the entity — no `dbReady` gate.
     *
     * The gate used to resolve `false` when the DATABASE_READY lifecycle
     * phase had not fired, which is never emitted by standalone scripts
     * (`bun scripts/x.ts` calling `getDb()` directly). Those scripts could
     * save fine — `Entity.save()` bypasses this manager entirely — while
     * every delete silently no-oped and reported the same `false` a
     * legitimately-skipped delete returns. The gate also guarded a
     * queue-for-later mechanism (`entityQueue`) that deletes never
     * participated in: a pending delete was simply discarded.
     *
     * If the DB genuinely is not reachable, the query layer throws — loudly
     * — which is the correct outcome. The only `false` `doDelete` returns is
     * "entity is not persisted".
     */
    public deleteEntity(entity: IEntity, force: boolean = false): Promise<boolean> {
        return entity.doDelete(force);
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