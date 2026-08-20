import { InvalidIdentifierError, assertIdentifier } from "../../query/SqlIdentifier";
import type { ParsedJoin } from "./types";

/** `Invoice.customerId = Customer.id` — right side MUST be `<Component>.id` (entity id). */
const JOIN_RE =
    /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.id$/;

export function parseJoinOn(on: string): ParsedJoin {
    if (typeof on !== "string" || on.trim().length === 0) {
        throw new InvalidIdentifierError("ReadModel.join.on", String(on));
    }
    const m = on.trim().match(JOIN_RE);
    if (!m) {
        throw new Error(
            `ReadModel join.on must look like "Invoice.customerId = Customer.id" (right side is the other entity's id). Got: ${on}`
        );
    }
    return {
        leftComponent: assertIdentifier(m[1], "ReadModel.join.leftComponent"),
        leftField: assertIdentifier(m[2], "ReadModel.join.leftField"),
        rightComponent: assertIdentifier(m[3], "ReadModel.join.rightComponent"),
    };
}

/** Table names are `m3_<lower name>` so they cannot collide with QSP `rm_<archetype>`. */
export function m3TableName(modelName: string): string {
    const ident = assertIdentifier(modelName, "ReadModel.name");
    return `m3_${ident.toLowerCase()}`;
}

export function assertM3TableName(name: string): string {
    if (typeof name !== "string" || !/^m3_[a-z][a-z0-9_]*$/.test(name)) {
        throw new InvalidIdentifierError("m3TableName", String(name));
    }
    if (name.startsWith("rm_")) {
        throw new InvalidIdentifierError("m3TableName(qspCollision)", name);
    }
    return name;
}
