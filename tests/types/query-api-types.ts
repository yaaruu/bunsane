/**
 * Type-level contract for Query. Checked by `tsc --noEmit` (this file is part
 * of the program). Runtime is a no-op so a test file can import it.
 */
import { Query, FilterOp } from "../../query/Query";
import { BaseComponent } from "../../core/components/BaseComponent";

class Position extends BaseComponent {
    x = 0;
    y = 0;
}

class Velocity extends BaseComponent {
    speed = 0;
}

type Assert<T extends true> = T;
type MaybeUndefined<T> = undefined extends T ? true : false;

export async function assertQueryTypes(): Promise<void> {
    const bare = new Query().with(Position);
    const unpopulated = await bare.exec();
    const unpopulatedRow = unpopulated[0]!;
    const _unpopulated: Assert<MaybeUndefined<(typeof unpopulatedRow.componentData)["Position"]>> = true;
    void _unpopulated;

    const populatedQuery = new Query().with(Position).with(Velocity).populate();
    const populated = await populatedQuery.exec();
    const populatedRow = populated[0]!;
    const _populatedPos: Assert<MaybeUndefined<(typeof populatedRow.componentData)["Position"]> extends false ? true : false> = true;
    const _populatedVel: Assert<MaybeUndefined<(typeof populatedRow.componentData)["Velocity"]> extends false ? true : false> = true;
    void _populatedPos;
    void _populatedVel;

    new Query().with(Position, {
        filters: [{ field: "x", operator: FilterOp.EQ, value: 1 }],
    });
    new Query().with(Position, {
        filters: [Query.filter("y", FilterOp.GT, 0)],
    });

    new Query().with(Position, {
        filters: [{
            // @ts-expect-error field is not a key of Position
            field: "nope",
            operator: FilterOp.EQ,
            value: 1,
        }],
    });

    const listed = new Query().with([
        { component: Position, filters: [{ field: "x", operator: FilterOp.EQ, value: 1 }] },
        { component: Velocity, filters: [{ field: "speed", operator: FilterOp.GTE, value: 0 }] },
    ]);
    const listedRows = await listed.exec();
    const listedRow = listedRows[0]!;
    const _listed: Assert<MaybeUndefined<(typeof listedRow.componentData)["Position"]>> = true;
    const _listedVel: Assert<MaybeUndefined<(typeof listedRow.componentData)["Velocity"]>> = true;
    void _listed;
    void _listedVel;

    const listedPop = new Query().with([
        { component: Position },
        { component: Velocity },
    ]).populate();
    const listedPopRows = await listedPop.exec();
    const listedPopRow = listedPopRows[0]!;
    const _listedPop: Assert<MaybeUndefined<(typeof listedPopRow.componentData)["Velocity"]> extends false ? true : false> = true;
    void _listedPop;
}
