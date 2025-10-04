import "reflect-metadata";
export {getMetadataStorage} from "./getMetadataStorage";
export function Enum() {
    return Reflect.metadata("isEnum", true);
}