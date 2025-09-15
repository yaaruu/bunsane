import BaseService from "./Service";
import { ServiceRegistry } from "index";
import { httpEndpoint } from "../rest";

export {
    BaseService,
    ServiceRegistry
}

// Shorthand decorators for HTTP methods
export const Get = (path: string) => httpEndpoint({ method: 'GET', path });
export const Post = (path: string) => httpEndpoint({ method: 'POST', path });
export const Put = (path: string) => httpEndpoint({ method: 'PUT', path });
export const Delete = (path: string) => httpEndpoint({ method: 'DELETE', path });
export const Patch = (path: string) => httpEndpoint({ method: 'PATCH', path });
export const Options = (path: string) => httpEndpoint({ method: 'OPTIONS', path });
export const Head = (path: string) => httpEndpoint({ method: 'HEAD', path });