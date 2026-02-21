import {
    handleStudioTableRequest,
    handleStudioTableDeleteRequest,
    handleGetTables,
} from "./tables";
import {
    handleStudioArcheTypeRecordsRequest,
    handleStudioArcheTypeDeleteRequest,
} from "./archetypes";
import { handleEntityInspectorRequest } from "./entity";
import { handleStudioStatsRequest } from "./stats";
import { handleStudioComponentsRequest } from "./components";
import { handleStudioQueryRequest } from "./query";

const studioEndpoint = {
    handleStudioTableRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioTableDeleteRequest,
    handleStudioArcheTypeDeleteRequest,
    handleEntityInspectorRequest,
    handleStudioStatsRequest,
    handleStudioComponentsRequest,
    handleStudioQueryRequest,
    getTables: handleGetTables,
};

export default studioEndpoint;
