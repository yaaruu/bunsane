import {
    handleStudioTableRequest,
    handleStudioTableDeleteRequest,
    handleGetTables,
} from "./tables";
import {
    handleStudioArcheTypeRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioArcheTypeDeleteRequest,
} from "./archetypes";

const studioEndpoint = {
    handleStudioTableRequest,
    handleStudioArcheTypeRequest,
    handleStudioArcheTypeRecordsRequest,
    handleStudioTableDeleteRequest,
    handleStudioArcheTypeDeleteRequest,
    getTables: handleGetTables,
};

export default studioEndpoint;