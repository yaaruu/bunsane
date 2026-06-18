import { z, ZodObject } from "zod";
import { weave } from "@gqloom/core";
import { ZodWeaver, asObjectType, asUnionType } from "@gqloom/zod";
import { printSchema } from "graphql";
import "reflect-metadata";
import { getMetadataStorage } from "../metadata";
import { compNameToFieldName, shouldUnwrapComponent } from "./helpers";
import { getOrCreateComponentSchema } from "./schemaBuilder";
import {
    customTypeRegistry,
    customTypeNameRegistry,
    registeredCustomTypes,
    inputTypeRegistry,
} from "./customTypes";
import { archetypeSchemaCache, allArchetypeZodObjects } from "./weaver";

/**
 * Build the Zod object schema for an archetype, register it in caches, and return it.
 * Extracted from BaseArcheType.getZodObjectSchema().
 */
export function buildZodObjectSchema(
    archetype: any,
    options?: { excludeRelations?: boolean; excludeFunctions?: boolean }
): ZodObject<any> {
    const excludeRelations = options?.excludeRelations ?? false;
    const excludeFunctions = options?.excludeFunctions ?? false;
    const zodShapes: Record<string, any> = {};
    const storage = getMetadataStorage();
    const unionSchemas: Array<{
        fieldName: string;
        schema: any;
        components: any[];
    }> = [];

    for (const [field, ctor] of Object.entries(archetype.componentMap)) {
        if (field.startsWith("union_")) {
            continue;
        }

        const componentCtor = ctor as any;
        const type = archetype.fieldTypes[field];
        const typeId = storage.getComponentId(componentCtor.name);
        const componentProps = storage.getComponentProperties(typeId);

        if (shouldUnwrapComponent(componentProps, type)) {
            if (type === String) {
                zodShapes[field] = z.string();
            } else if (type === Number) {
                zodShapes[field] = z.number();
            } else if (type === Boolean) {
                zodShapes[field] = z.boolean();
            } else if (type === Date) {
                zodShapes[field] = z.date();
            }
        } else {
            const componentSchema = getOrCreateComponentSchema(
                componentCtor,
                typeId,
                archetype.fieldOptions[field]
            );
            if (componentSchema) {
                zodShapes[field] = componentSchema;
            } else {
                continue;
            }
        }

        if (
            archetype.fieldOptions[field]?.nullable &&
            zodShapes[field] &&
            !(zodShapes[field] instanceof ZodObject)
        ) {
            zodShapes[field] = zodShapes[field].nullish();
        }
    }

    for (const [fieldName, components] of Object.entries(archetype.unionMap)) {
        const componentList = components as any[];
        const unionComponentSchemas: any[] = [];
        const unionComponentCtors: any[] = [];

        for (const component of componentList) {
            const typeId = storage.getComponentId(component.name);
            const componentSchema = getOrCreateComponentSchema(
                component,
                typeId,
                archetype.unionOptions[fieldName]
            );

            if (componentSchema) {
                unionComponentSchemas.push(componentSchema);
                unionComponentCtors.push(component);
            }
        }

        if (unionComponentSchemas.length > 0) {
            const unionSchema = z
                .union(unionComponentSchemas)
                .register(asUnionType, {
                    name:
                        fieldName.charAt(0).toUpperCase() +
                        fieldName.slice(1),
                    resolveType: (it: any) => {
                        if (it.__typename) {
                            return it.__typename;
                        }
                        for (
                            let i = 0;
                            i < unionComponentCtors.length;
                            i++
                        ) {
                            const componentProps =
                                storage.getComponentProperties(
                                    storage.getComponentId(
                                        unionComponentCtors[i].name
                                    )
                                );
                            const hasUniqueProps = componentProps.some(
                                (prop) =>
                                    it.hasOwnProperty(prop.propertyKey)
                            );
                            if (hasUniqueProps) {
                                return compNameToFieldName(
                                    unionComponentCtors[i].name
                                );
                            }
                        }
                        return compNameToFieldName(
                            unionComponentCtors[0].name
                        );
                    },
                });

            zodShapes[fieldName] = unionSchema;
            unionSchemas.push({
                fieldName,
                schema: unionSchema,
                components: unionComponentSchemas,
            });

            if (archetype.unionOptions[fieldName]?.nullable) {
                zodShapes[fieldName] = zodShapes[fieldName].nullish();
            }
        }
    }

    if (!excludeRelations) {
        for (const [field, relatedArcheType] of Object.entries(archetype.relationMap)) {
            const relationType = archetype.relationTypes[field];
            const isArray =
                relationType === "hasMany" || relationType === "belongsToMany";

            let relatedTypeName: string;
            if (typeof relatedArcheType === "string") {
                relatedTypeName = relatedArcheType;
            } else {
                const relatedArchetypeId = storage.getComponentId(
                    (relatedArcheType as any).name
                );
                const relatedArchetypeMetadata = storage.archetypes.find(
                    (a) => a.typeId === relatedArchetypeId
                );
                relatedTypeName =
                    relatedArchetypeMetadata?.name ||
                    (relatedArcheType as any).name.replace(/ArcheType$/, "");
            }

            const relatedTypeSchema = z
                .string()
                .describe(`Reference to ${relatedTypeName} type`);

            if (isArray) {
                const shouldBeRequired = archetype.relationOptions[field]?.nullable === false;
                zodShapes[field] = shouldBeRequired
                    ? z.array(relatedTypeSchema)
                    : z.array(relatedTypeSchema).optional();
            } else {
                zodShapes[field] = relatedTypeSchema;

                if (archetype.relationOptions[field]?.nullable) {
                    zodShapes[field] = zodShapes[field].nullish();
                }
            }
        }
    }

    const functionInputTypes = new Map<string, string>();

    if (!excludeFunctions) {
        for (const { propertyKey, options } of archetype.functions) {
            let zodType;
            if (options?.returnType === 'number') {
                zodType = z.number();
            } else if (options?.returnType === 'string') {
                zodType = z.string();
            } else if (options?.returnType === 'boolean') {
                zodType = z.boolean();
            } else if (options?.returnType) {
                zodType = z.string().describe(`Reference to ${options.returnType} type`);
            } else {
                const returnType = Reflect.getMetadata("design:returntype", archetype.constructor.prototype, propertyKey);
                if (returnType === String) {
                    zodType = z.string();
                } else if (returnType === Number) {
                    zodType = z.number();
                } else if (returnType === Boolean) {
                    zodType = z.boolean();
                } else {
                    zodType = z.any();
                }
            }

            if (options?.args && options.args.length > 0) {
                const archetypeId = storage.getComponentId(archetype.constructor.name);
                const archetypeName =
                    storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
                    archetype.constructor.name;
                const inputTypeName = `${archetypeName}_${propertyKey}Args`;

                const inputFields: Record<string, any> = {};
                for (const arg of options.args) {
                    let argZodType: any;

                    if (customTypeRegistry.has(arg.type)) {
                        argZodType = customTypeRegistry.get(arg.type)!;
                    } else if (arg.type === String || arg.type === String) {
                        argZodType = z.string();
                    } else if (arg.type === Number) {
                        argZodType = z.number();
                    } else if (arg.type === Boolean) {
                        argZodType = z.boolean();
                    } else if (arg.type === Date) {
                        argZodType = z.date();
                    } else if (registeredCustomTypes.has(arg.type?.name || '')) {
                        argZodType = registeredCustomTypes.get(arg.type.name);
                    } else {
                        const typeName = customTypeNameRegistry.get(arg.type);
                        if (typeName && registeredCustomTypes.has(typeName)) {
                            argZodType = registeredCustomTypes.get(typeName);
                        } else {
                            console.warn(`[ArcheType] Unknown argument type for ${archetypeName}.${propertyKey}.${arg.name}: ${arg.type?.name || arg.type}. Falling back to z.any()`);
                            argZodType = z.any();
                        }
                    }

                    if (arg.nullable) {
                        argZodType = argZodType.optional();
                    }

                    inputFields[arg.name] = argZodType;
                }

                const inputSchema = z.object(inputFields).register(asObjectType, { name: inputTypeName });
                registeredCustomTypes.set(inputTypeName, inputSchema);
                functionInputTypes.set(propertyKey, inputTypeName);
            }

            zodShapes[propertyKey] = zodType.optional();
        }
    }

    const archetypeId = storage.getComponentId(archetype.constructor.name);
    const nameFromStorage =
        storage.archetypes.find((a) => a.typeId === archetypeId)?.name ||
        archetype.constructor.name;
    const shape: Record<string, any> = {
        __typename: z.literal(nameFromStorage).nullish(),
        id: z.string().nullish(),
    };
    for (const [field, zodType] of Object.entries(zodShapes)) {
        const isNullable =
            archetype.fieldOptions[field]?.nullable ||
            archetype.unionOptions[field]?.nullable;
        if (isNullable) {
            shape[field] = zodType.optional();
        } else {
            shape[field] = zodType;
        }
    }
    const r = z.object(shape);

    const componentSchemasToWeave: any[] = [];
    for (const [field, zodType] of Object.entries(zodShapes)) {
        if (zodType instanceof ZodObject) {
            componentSchemasToWeave.push(zodType);
        } else if (
            Array.isArray(zodType) ||
            (zodType &&
                typeof zodType === "object" &&
                zodType._def?.typeName === "ZodUnion")
        ) {
            if (zodType._def?.typeName === "ZodUnion") {
                componentSchemasToWeave.push(zodType);
            }
        }
    }

    const schemasToWeave = [r];
    const schema = weave(ZodWeaver, ...schemasToWeave);
    let graphqlSchemaString = printSchema(schema);

    graphqlSchemaString = graphqlSchemaString.replace(
        /\bid:\s*String\b/g,
        "id: ID"
    );

    for (const [field, relatedArcheType] of Object.entries(archetype.relationMap)) {
        const relationType = archetype.relationTypes[field];
        const isArray =
            relationType === "hasMany" || relationType === "belongsToMany";

        let relatedTypeName: string;
        if (typeof relatedArcheType === "string") {
            relatedTypeName = relatedArcheType;
        } else {
            const relatedArchetypeId = storage.getComponentId(
                (relatedArcheType as any).name
            );
            const relatedArchetypeMetadata = storage.archetypes.find(
                (a) => a.typeId === relatedArchetypeId
            );
            relatedTypeName =
                relatedArchetypeMetadata?.name ||
                (relatedArcheType as any).name.replace(/ArcheType$/, "");
        }

        if (isArray) {
            const shouldBeRequired = archetype.relationOptions[field]?.nullable === false;
            const suffix = shouldBeRequired ? "!" : "";

            const descriptionPattern = new RegExp(`"""Reference to ${relatedTypeName} type"""[\\s\\S]*?${field}:`);
            if (!descriptionPattern.test(graphqlSchemaString)) {
                const addDescriptionPattern = new RegExp(
                    `(\\n\\s+)(${field}:\\s*\\[String!?\\]!?)`,
                    "g"
                );
                graphqlSchemaString = graphqlSchemaString.replace(
                    addDescriptionPattern,
                    `$1"""Reference to ${relatedTypeName} type"""\n$1$2`
                );
            }

            const replaceTypePattern = new RegExp(
                `(${field}:\\s*)\\[String!?\\](!?)`,
                "g"
            );
            graphqlSchemaString = graphqlSchemaString.replace(
                replaceTypePattern,
                `$1[${relatedTypeName}!]${suffix}`
            );
        } else {
            const isNullable = archetype.relationOptions[field]?.nullable;
            const suffix = isNullable ? "" : "!";
            const pattern = new RegExp(`${field}:\\s*String!?`, "g");
            graphqlSchemaString = graphqlSchemaString.replace(
                pattern,
                `${field}: ${relatedTypeName}${suffix}`
            );
        }
    }

    if (!excludeFunctions) {
        for (const { propertyKey, options } of archetype.functions) {
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
                        } else if (customTypeRegistry.has(arg.type)) {
                            const registeredName = Array.from(registeredCustomTypes.entries())
                                .find(([name, schema]) => schema === customTypeRegistry.get(arg.type))?.[0];
                            argTypeName = registeredName || 'String';
                        } else if (arg.type === String) {
                            argTypeName = 'String';
                        } else if (arg.type === Number) {
                            argTypeName = 'Float';
                        } else if (arg.type === Boolean) {
                            argTypeName = 'Boolean';
                        } else if (arg.type === Date) {
                            argTypeName = 'Date';
                        } else if (arg.type?.name && registeredCustomTypes.has(arg.type.name)) {
                            argTypeName = arg.type.name;
                        } else if (arg.type?.name) {
                            argTypeName = arg.type.name;
                        } else {
                            argTypeName = 'String';
                        }
                    }

                    const nullable = arg.nullable ? '' : '!';
                    argDefs.push(`${arg.name}: ${argTypeName}${nullable}`);
                }

                const escapedKey = propertyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const escapedTypeName = nameFromStorage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                const argsString = argDefs.join(', ');

                console.log(`[ArcheType] Adding arguments to ${nameFromStorage}.${propertyKey}: ${argsString}`);

                const typeStartPattern = new RegExp(`type\\s+${escapedTypeName}\\s*\\{`, 'i');
                let typeStartMatch = graphqlSchemaString.match(typeStartPattern);

                if (!typeStartMatch) {
                    const caseInsensitivePattern = new RegExp(`type\\s+([^\\s{]+)\\s*\\{`, 'gi');
                    const allTypes = [...graphqlSchemaString.matchAll(caseInsensitivePattern)];
                    const matchingType = allTypes.find(match =>
                        match[1]!.toLowerCase() === nameFromStorage.toLowerCase()
                    );
                    if (matchingType && matchingType.index !== undefined) {
                        typeStartMatch = [matchingType[0], matchingType[1]] as RegExpMatchArray;
                        typeStartMatch.index = matchingType.index;
                    }
                }

                if (typeStartMatch) {
                    const typeStartIndex = typeStartMatch.index! + typeStartMatch[0].length;
                    let braceCount = 1;
                    let typeEndIndex = typeStartIndex;
                    for (let i = typeStartIndex; i < graphqlSchemaString.length && braceCount > 0; i++) {
                        if (graphqlSchemaString[i] === '{') braceCount++;
                        if (graphqlSchemaString[i] === '}') braceCount--;
                        if (braceCount === 0) {
                            typeEndIndex = i;
                            break;
                        }
                    }

                    const typeDefinition = graphqlSchemaString.substring(typeStartIndex, typeEndIndex);

                    console.log(`[ArcheType] Type definition for ${nameFromStorage}:`, typeDefinition.substring(0, 200));

                    const fieldPattern = new RegExp(
                        `(\\n\\s+)(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                        'g'
                    );

                    const fieldMatch = fieldPattern.exec(typeDefinition);
                    if (fieldMatch) {
                        const returnType = fieldMatch[3]!.trim();
                        const indent = fieldMatch[1];
                        const replacement = `${indent}${propertyKey}(${argsString}): ${returnType}`;

                        console.log(`[ArcheType] Found field match: "${fieldMatch[0]}" -> "${replacement}"`);

                        const fullMatchStart = typeStartIndex + fieldMatch.index!;
                        const fullMatchEnd = fullMatchStart + fieldMatch[0].length;
                        graphqlSchemaString =
                            graphqlSchemaString.substring(0, fullMatchStart) +
                            replacement +
                            graphqlSchemaString.substring(fullMatchEnd);

                        console.log(`[ArcheType] Replacement successful for ${nameFromStorage}.${propertyKey}`);
                    } else {
                        console.warn(`[ArcheType] Field pattern not found in type definition. Looking for: ${escapedKey}`);
                        const simplePattern = new RegExp(
                            `(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                            'g'
                        );
                        const beforeReplace = graphqlSchemaString;
                        graphqlSchemaString = graphqlSchemaString.replace(
                            simplePattern,
                            (match, fieldDef, returnType) => {
                                console.log(`[ArcheType] Fallback replacement: "${match}" -> "${propertyKey}(${argsString}): ${returnType.trim()}"`);
                                return `${propertyKey}(${argsString}): ${returnType.trim()}`;
                            }
                        );
                        if (beforeReplace === graphqlSchemaString) {
                            console.warn(`[ArcheType] Fallback replacement also failed for ${nameFromStorage}.${propertyKey}`);
                        }
                    }
                } else {
                    console.warn(`[ArcheType] Type pattern not found for ${nameFromStorage}. Schema snippet:`, graphqlSchemaString.substring(0, 300));
                    const simplePattern = new RegExp(
                        `(${escapedKey}\\??\\s*:\\s*)([^\\n]+)`,
                        'g'
                    );
                    const beforeReplace = graphqlSchemaString;
                    graphqlSchemaString = graphqlSchemaString.replace(
                        simplePattern,
                        (match, fieldDef, returnType) => {
                            console.log(`[ArcheType] Final fallback replacement: "${match}" -> "${propertyKey}(${argsString}): ${returnType.trim()}"`);
                            return `${propertyKey}(${argsString}): ${returnType.trim()}`;
                        }
                    );
                    if (beforeReplace === graphqlSchemaString) {
                        console.warn(`[ArcheType] All replacement attempts failed for ${nameFromStorage}.${propertyKey}`);
                    }
                }
            }

            if (options?.returnType && !['string', 'number', 'boolean'].includes(options.returnType)) {
                const fieldIndex = graphqlSchemaString.indexOf(`  ${propertyKey}`);
                if (fieldIndex !== -1) {
                    const lineStart = fieldIndex;
                    const lineEnd = graphqlSchemaString.indexOf('\n', fieldIndex);
                    const fieldLine = graphqlSchemaString.substring(lineStart, lineEnd !== -1 ? lineEnd : graphqlSchemaString.length);

                    const updatedLine = fieldLine.replace(/:\s*String(\??)(\s*)$/, `: ${options.returnType}$1$2`);

                    if (updatedLine !== fieldLine) {
                        graphqlSchemaString = graphqlSchemaString.substring(0, lineStart) +
                                             updatedLine +
                                             graphqlSchemaString.substring(lineEnd !== -1 ? lineEnd : graphqlSchemaString.length);
                    }
                }
            }
        }
    }

    const cacheKey = `${nameFromStorage}_${excludeRelations}_${excludeFunctions}`;
    archetypeSchemaCache.set(cacheKey, {
        zodSchema: r,
        graphqlSchema: graphqlSchemaString,
    });

    // Only cache the canonical full variant in the shared map. Function-less /
    // relation-less variants (e.g. from getInputSchema) must not overwrite it,
    // or weaveAllArchetypes welds SDL missing @ArcheTypeFunction fields → resolver/schema mismatch.
    if (!excludeRelations && !excludeFunctions) {
        allArchetypeZodObjects.set(nameFromStorage, r);
    }

    return r;
}
