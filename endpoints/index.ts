import {
    handleStudioTableRequest,
    handleStudioTableDeleteRequest,
    handleGetTables,
} from "./tables";
import {
    handleStudioArcheTypeRecordsRequest,
    handleStudioArcheTypeDeleteRequest,
} from "./archetypes";

const studioEndpoint = {
    handleStudioTableRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioTableDeleteRequest,
    handleStudioArcheTypeDeleteRequest,
    getTables: handleGetTables,
};

export default studioEndpoint;
