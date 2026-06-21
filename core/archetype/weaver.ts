import { ZodObject } from "zod";
import { weave } from "@gqloom/core";
import { ZodWeaver } from "@gqloom/zod";
import { printSchema } from "graphql";
import { getMetadataStorage } from "../metadata";
import { componentSchemaCache } from "./schemaBuilder";
import { inputTypeRegistry, customTypeNameRegistry } from "./customTypes";
import { logger } from "../Logger";

export const archetypeSchemaCache = new Map<
    string,
    { zodSchema: ZodObject<any>; graphqlSchema: string }
>();
export const allArchetypeZodObjects = new Map<string, ZodObject<any>>();

export function getArchetypeSchema(archetypeName: string, excludeRelations = false, excludeFunctions = false) {
    const cacheKey = `${archetypeName}_${excludeRelations}_${excludeFunctions}`;
    return archetypeSchemaCache.get(cacheKey);
}

export function getAllArchetypeSchemas() {
    return Array.from(archetypeSchemaCache.entries())
        .filter(([key]) => key.endsWith('_false_false'))
        .map(([, value]) => value);
}

export function weaveAllArchetypes() {
    const storage = getMetadataStorage();
    const archetypeNames: string[] = [];

    for (const archetypeMetadata of storage.archetypes) {
        const archetypeName = archetypeMetadata.name;
        archetypeNames.push(archetypeName);
        const fullSchemaCacheKey = `${archetypeName}_false_false`;
        if (!archetypeSchemaCache.has(fullSchemaCacheKey)) {
            try {
                const ArchetypeClass = archetypeMetadata.target as any;
                const instance = new ArchetypeClass();
                instance.getZodObjectSchema();
            } catch (error) {
                logger.warn(
                    { scope: 'weaver', archetype: archetypeName, error },
                    `Could not generate schema for archetype ${archetypeName}`
                );
            }
        }
    }

    if (allArchetypeZodObjects.size === 0) {
        return null;
    }
    const archetypeSchemas = Array.from(allArchetypeZodObjects.values());
    const componentSchemas = Array.from(componentSchemaCache.values());

    const allSchemas = archetypeSchemas;

    try {
        const schema = weave(ZodWeaver, ...allSchemas);
        let schemaString = printSchema(schema);

        if (!schemaString.includes('scalar Date')) {
            schemaString = 'scalar Date\n\n' + schemaString;
        }

        schemaString = schemaString.replace(/\bid:\s*String\b/g, "id: ID");

        schemaString = schemaString.replace(/\b(\w*_at|\w*_date|\w*Date|date\w*):\s*String(!?)/gi, (match, fieldName, nullable) => {
            return `${fieldName}: Date${nullable}`;
        });

        for (const archetypeMetadata of storage.archetypes) {
            const archetypeName = archetypeMetadata.name;
            try {
                const ArchetypeClass = archetypeMetadata.target as any;
                const instance = new ArchetypeClass();

                for (const [field, relatedArcheType] of Object.entries(instance.relationMap)) {
                    const relationType = instance.relationTypes[field];
                    const isArray = relationType === "hasMany" || relationType === "belongsToMany";

                    let relatedTypeName: string;
                    if (typeof relatedArcheType === "string") {
                        relatedTypeName = relatedArcheType;
                    } else {
                        const relatedArchetypeId = storage.getComponentId((relatedArcheType as any).name);
                        const relatedArchetypeMetadata = storage.archetypes.find(
                            (a) => a.typeId === relatedArchetypeId
                        );
                        relatedTypeName = relatedArchetypeMetadata?.name || (relatedArcheType as any).name.replace(/ArcheType$/, "");
                    }

                    if (isArray) {
                        const hasDescription = new RegExp(`"""Reference to ${relatedTypeName} type"""[\\s\\S]{0,50}${field}:`).test(schemaString);
                        if (!hasDescription) {
                            const addDescPattern = new RegExp(
                                `(type ${archetypeName} \\{[\\s\\S]*?)(\\n\\s+)(${field}:\\s*\\[String!?\\]!?)`,
                                "g"
                            );
                            schemaString = schemaString.replace(
                                addDescPattern,
                                `$1$2"""Reference to ${relatedTypeName} type"""$2$3`
                            );
                        }

                        const shouldBeRequired = instance.relationOptions[field]?.nullable === false;
                        const suffix = shouldBeRequired ? "!" : "";
                        const replacePattern = new RegExp(
                            `(type ${archetypeName} \\{[\\s\\S]*?${field}:\\s*)\\[String!?\\](!?)`,
                            "g"
                        );
                        schemaString = schemaString.replace(
                            replacePattern,
                            `$1[${relatedTypeName}!]${suffix}`
                        );
                    } else {
                        const pattern = new RegExp(
                            `(type ${archetypeName} \\{[\\s\\S]*?${field}:\\s*)String(!?)`,
                            "g"
                        );
                        const isNullable = instance.relationOptions[field]?.nullable;
                        const suffix = isNullable ? "" : "!";
                        schemaString = schemaString.replace(
                            pattern,
                            `$1${relatedTypeName}${suffix}`
                        );
                    }
                }
            } catch (error) {
                logger.warn({ scope: 'weaver', archetype: archetypeMetadata.name, error }, `Could not process relations for archetype ${archetypeMetadata.name}`);
            }

            if (archetypeMetadata.functions) {
                for (const { propertyKey, options } of archetypeMetadata.functions) {

                    if (options?.args && options.args.length > 0) {
                        const argDefs: string[] = [];
                        for (const arg of options.args) {
                            let argTypeName: string;

                            const inputTypeName = inputTypeRegistry.get(arg.type);
                            if (inputTypeName) {
                                argTypeName = inputTypeName;
                            } else {
                                const registeredTypeName = customTypeNameRegistry.get(arg.type);
                                if (registeredTypeName) {
                                    argTypeName = registeredTypeName;
                                } else if (arg.type === String) {
                                    argTypeName = 'String';
                                } else if (arg.type === Number) {
                                    argTypeName = 'Float';
                                } else if (arg.type === Boolean) {
                                    argTypeName = 'Boolean';
                                } else if (arg.type === Date) {
                                    argTypeName = 'Date';
                                } else if (arg.type?.name) {
                                    argTypeName = arg.type.name;
                                } else {
                                    argTypeName = 'String';
                                }
                            }

                            const nullable = arg.nullable ? '' : '!';
                            argDefs.push(`${arg.name}: ${argTypeName}${nullable}`);
                        }

                        const argsString = argDefs.join(', ');
                        const escapedKey = propertyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                        const argPattern = new RegExp(
                            `(\\s+)(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                            'g'
                        );

                        schemaString = schemaString.replace(
                            argPattern,
                            (match, leadingSpace, fieldDef, returnType) => {
                                return `${leadingSpace}${fieldDef.trim().replace(':', '')}(${argsString}): ${returnType.trim()}`;
                            }
                        );
                    }

                    if (options?.returnType && !['string', 'number', 'boolean'].includes(options.returnType)) {
                        const typePattern = new RegExp(`type ${archetypeName}\\s*\\{([\\s\\S]*?)\\n\\}`, 'g');
                        const typeMatch = typePattern.exec(schemaString);

                        if (typeMatch) {
                            const typeBody = typeMatch[1]!;

                            const fieldIndex = typeBody.indexOf(`  ${propertyKey}`);
                            if (fieldIndex !== -1) {
                                const lineStart = fieldIndex;
                                const lineEnd = typeBody.indexOf('\n', fieldIndex);
                                const fieldLine = typeBody.substring(lineStart, lineEnd !== -1 ? lineEnd : typeBody.length);

                                const updatedLine = fieldLine.replace(/:\s*String(\??)(\s*)$/, `: ${options.returnType}$1$2`);

                                if (updatedLine !== fieldLine) {
                                    const fullFieldIndex = schemaString.indexOf(typeMatch[0]) + typeMatch[0].indexOf(fieldLine);
                                    schemaString = schemaString.substring(0, fullFieldIndex) +
                                                 updatedLine +
                                                 schemaString.substring(fullFieldIndex + fieldLine.length);
                                }
                            }
                        }
                    }
                }
            }
        }

        return schemaString;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // graphql-js rejects a schema carrying two same-named types
        // ("...must contain uniquely named types but contains multiple types
        // named 'X'..."). The DeduplicationVisitor drops the duplicate and the
        // schema still weaves and serves downstream, so this is recovered noise
        // — log at debug. Any OTHER weave failure stays at warn so real
        // breakage remains visible.
        if (/multiple types named|uniquely named types/i.test(msg)) {
            logger.debug(
                { scope: 'weaver', archetypes: archetypeNames },
                `Duplicate GraphQL type during archetype weave — deduplicated, schema unaffected: ${msg}`
            );
        } else {
            logger.warn(
                { scope: 'weaver', archetypes: archetypeNames, error },
                'Failed to weave all archetypes'
            );
        }
        return null;
    }
}
