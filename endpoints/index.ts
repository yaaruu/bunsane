import {
    handleStudioTableRequest,
    handleStudioTableDeleteRequest,
    handleGetTables,
} from "./tables";
import {
    handleStudioArcheTypeRecordsRequest,
    handleStudioArcheTypeDeleteRequest,
} from "./archetypes";
import { handleEntityInspectorRequest, handleEntityListRequest } from "./entity";
import { handleStudioStatsRequest } from "./stats";
import { handleStudioComponentsRequest } from "./components";
import { handleStudioQueryRequest } from "./query";

const studioEndpoint = {
    handleStudioTableRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioTableDeleteRequest,
    handleStudioArcheTypeDeleteRequest,
    handleEntityInspectorRequest,
    handleEntityListRequest,
    handleStudioStatsRequest,
    handleStudioComponentsRequest,
    handleStudioQueryRequest,
    getTables: handleGetTables,
};

export default studioEndpoint;
