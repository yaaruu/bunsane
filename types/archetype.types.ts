export interface GetEntityOptions {
    includeComponents?: string[];
    excludeComponents?: string[];
    populateRelations?: boolean;
    throwOnNotFound?: boolean;
}