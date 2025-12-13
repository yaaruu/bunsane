import { GraphQLType } from "../helpers";
import { ZodType } from "zod";
import BaseArcheType from "../../core/ArcheType";
import { logger } from "../../core/Logger";

export interface TypeGenerationResult {
  typeDef: string;
  fieldType?: string;
  resolverWrapper?: (resolver: Function) => Function;
  inputTypeName?: string;
}

export interface TypeGenerationContext {
  isInput: boolean;
  operationName: string;
  definedInputTypes: Set<string>;
  scalarTypes: Set<string>;
}

export interface TypeGenerationStrategy {
  canHandle(meta: any): boolean;
  generateTypeDef(meta: any, context: TypeGenerationContext): TypeGenerationResult;
  generateResolver?(originalResolver: Function, meta: any): Function;
}

/**
 * Strategy for Zod schema-based input generation
 */
export class ZodTypeStrategy implements TypeGenerationStrategy {
  canHandle(meta: any): boolean {
    return !!(meta && typeof meta === 'object' && '_def' in meta);
  }

  generateTypeDef(meta: ZodType, context: TypeGenerationContext): TypeGenerationResult {
    // Extracted logic from existing generator for Zod inputs
    const inputName = `${context.operationName}Input`;
    let originalInput = meta;

    // Handle optional schemas
    let innerInput = meta;
    const wasOptional = meta instanceof (require('zod')).ZodOptional;
    if (wasOptional) {
      innerInput = meta.unwrap();
    }

    // Preprocess schema for unions with scalar literals
    const shape = typeof innerInput._def.shape === 'function' ? innerInput._def.shape() : innerInput._def.shape;
    if (shape) {
      const processedShape: any = {};
      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as any;
        const typeName = fieldSchema._def?.typeName || fieldSchema._def?.type;

        if (typeName === 'ZodUnion' || typeName === 'union') {
          const options = fieldSchema._def?.options || [];
          let foundScalarLiteral = null;

          for (const option of options) {
            const optionTypeName = option._def?.typeName || option._def?.type;
            if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
              const value = option._def?.value ?? (option._def?.values ? option._def.values[0] : undefined);
              if (typeof value === 'string' && context.scalarTypes.has(value)) {
                foundScalarLiteral = option;
                break;
              }
            }
          }

          processedShape[key] = foundScalarLiteral || fieldSchema;
        } else {
          processedShape[key] = fieldSchema;
        }
      }

      innerInput = (require('zod')).object(processedShape);
    }

    innerInput = innerInput.extend({ __typename: (require('zod')).literal(inputName).nullish() });
    if (wasOptional) {
      meta = innerInput.optional();
    } else {
      meta = innerInput;
    }

    const { weave, ZodWeaver } = require('@gqloom/core');
    const { printSchema } = require('graphql');
    const gqlInputSchema = weave(ZodWeaver, meta as ZodType) as any;
    const schemaString = printSchema(gqlInputSchema);

    const typeNames: string[] = [];
    schemaString.replace(/type (\w+)/g, (match, name) => {
      typeNames.push(name);
      return match;
    });

    let inputTypeDefs = schemaString.replace(/\btype\b/g, 'input');
    inputTypeDefs = inputTypeDefs.replace(/input (\w+)/g, (match, name) => {
      if (name.endsWith('Input')) {
        return `input ${name}`;
      } else {
        return `input ${name}Input`;
      }
    });

    inputTypeDefs = inputTypeDefs.replace(/: (\[?)(\w+)([!\[\]]*)(\s|$)/g, (match, bracketStart, type, suffix, end) => {
      if (typeNames.includes(type)) {
        return `: ${bracketStart}${type.endsWith('Input') ? type : type + 'Input'}${suffix}${end}`;
      } else {
        return match;
      }
    });

    // Deduplicate
    const deduplicatedInputTypeDefs = this.deduplicateInputTypes(inputTypeDefs, context.definedInputTypes);
    let typeDef = deduplicatedInputTypeDefs + '\n';

    // Post-process for literal scalars
    let schemaToTraverse: any = originalInput;
    const defType = (schemaToTraverse._def as any)?.typeName || (schemaToTraverse._def as any)?.type;
    if (defType === 'ZodOptional' || defType === 'optional') {
      schemaToTraverse = (schemaToTraverse as any)._def.innerType;
    }

    const literalFields: Record<string, string> = {};
    this.traverseZod(schemaToTraverse, literalFields, context.scalarTypes);

    for (const [fieldPath, scalarName] of Object.entries(literalFields)) {
      const fieldName = fieldPath.split('.').pop()!;
      typeDef = typeDef.replace(new RegExp(`(\\s+${fieldName}:\\s+)String!`, 'g'), `$1${scalarName}!`);
    }

    return {
      typeDef,
      fieldType: `(input: ${inputName}${inputNullability})`,
      inputTypeName: inputName,
      resolverWrapper: (resolver) => this.wrapResolverWithZodValidation(resolver, originalInput)
    };
  }

  private deduplicateInputTypes(inputTypeDefs: string, definedTypes: Set<string>): string {
    const lines = inputTypeDefs.split('\n');
    const result: string[] = [];
    let currentType = '';
    let currentTypeName = '';
    let inTypeDefinition = false;

    for (const line of lines) {
      if (line.startsWith('input ')) {
        currentTypeName = line.split(' ')[1];
        if (definedTypes.has(currentTypeName)) {
          inTypeDefinition = false;
          currentType = '';
          continue;
        } else {
          definedTypes.add(currentTypeName);
          inTypeDefinition = true;
          currentType = line + '\n';
        }
      } else if (inTypeDefinition) {
        currentType += line + '\n';
        if (line.trim() === '}') {
          result.push(currentType);
          inTypeDefinition = false;
          currentType = '';
        }
      } else if (!inTypeDefinition && line.trim()) {
        result.push(line + '\n');
      }
    }

    return result.join('');
  }

  private traverseZod(obj: any, literalFields: Record<string, string>, scalarTypes: Set<string>, path: string[] = []) {
    if (!obj || !obj._def) return;
    const typeName = (obj._def as any).typeName || (obj._def as any).type;
    if (typeName === 'ZodLiteral' || typeName === 'literal') {
      const defObj = obj._def as any;
      const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
      if (typeof value === 'string' && scalarTypes.has(value)) {
        literalFields[path.join('.')] = value;
      }
    } else if (typeName === 'ZodUnion' || typeName === 'union') {
      const options = (obj._def as any).options || [];
      for (const option of options) {
        const optionTypeName = (option._def as any)?.typeName || (option._def as any)?.type;
        if (optionTypeName === 'ZodLiteral' || optionTypeName === 'literal') {
          const defObj = option._def as any;
          const value = defObj.value ?? (defObj.values ? defObj.values[0] : undefined);
          if (typeof value === 'string' && scalarTypes.has(value)) {
            literalFields[path.join('.')] = value;
            break;
          }
        }
      }
    } else if (typeName === 'ZodObject' || typeName === 'object') {
      const shape = typeof obj._def.shape === 'function' ? obj._def.shape() : obj._def.shape;
      if (shape) {
        for (const [key, value] of Object.entries(shape)) {
          this.traverseZod(value, literalFields, scalarTypes, [...path, key]);
        }
      }
    }
  }

  private wrapResolverWithZodValidation(resolver: Function, zodSchema: ZodType): Function {
    return async (_: any, args: any, context: any, info: any) => {
      try {
        const inputArgs = args.input || args;
        const validated = zodSchema.parse(inputArgs);
        return await resolver(validated, context, info);
      } catch (error) {
        if (error instanceof (require('zod')).ZodError) {
          const { handleGraphQLError } = await import("../../core/ErrorHandler");
          handleGraphQLError(error);
        }
        throw error;
      }
    };
  }
}

/**
 * Strategy for archetype output types
 */
export class ArchetypeTypeStrategy implements TypeGenerationStrategy {
  canHandle(meta: any): boolean {
    return meta instanceof BaseArcheType || (Array.isArray(meta) && meta[0] instanceof BaseArcheType);
  }

  generateTypeDef(meta: BaseArcheType | BaseArcheType[], context: TypeGenerationContext): TypeGenerationResult {
    const { getArchetypeTypeName } = require("../../core/ArcheType");

    if (Array.isArray(meta)) {
      const archetypeInstance = meta[0];
      const typeName = getArchetypeTypeName(archetypeInstance);
      if (typeName) {
        return { typeDef: '', fieldType: `: [${typeName}]` };
      } else {
        logger.warn(`Invalid array output type for ${context.operationName}, expected archetype instance`);
        return { typeDef: '', fieldType: `: [Any]` };
      }
    } else {
      const typeName = getArchetypeTypeName(meta);
      if (typeName) {
        return { typeDef: '', fieldType: `: ${typeName}` };
      } else {
        logger.warn(`Could not determine type name for archetype in ${context.operationName}`);
        return { typeDef: '', fieldType: `: Any` };
      }
    }
  }
}

/**
 * Strategy for legacy Record<string, GraphQLType> format
 */
export class LegacyTypeStrategy implements TypeGenerationStrategy {
  canHandle(meta: any): boolean {
    return meta && typeof meta === 'object' && !('_def' in meta) && !this.isArchetype(meta);
  }

  private isArchetype(meta: any): boolean {
    return meta instanceof BaseArcheType || (Array.isArray(meta) && meta[0] instanceof BaseArcheType);
  }

  generateTypeDef(meta: Record<string, GraphQLType>, context: TypeGenerationContext): TypeGenerationResult {
    if (context.isInput) {
      // Input type
      const inputName = `${context.operationName}Input`;
      const typeDef = `input ${inputName} {\n${Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
      return { typeDef, fieldType: `(input: ${inputName}!)`, inputTypeName: inputName };
    } else {
      // Output type
      const outputName = `${context.operationName}Output`;
      const typeDef = `type ${outputName} {\n${Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n`;
      return { typeDef, fieldType: `: ${outputName}` };
    }
  }

  private isInputLike(meta: Record<string, GraphQLType>): boolean {
    // Heuristic: if operationName ends with 'Input' or has input-like fields, treat as input
    // For now, assume if it's used as input in context, but since we don't have context, check field names
    return true; // Default to input for legacy, adjust based on usage
  }
}

/**
 * Strategy for primitive string-based types
 */
export class PrimitiveTypeStrategy implements TypeGenerationStrategy {
  canHandle(meta: any): boolean {
    return typeof meta === 'string';
  }

  generateTypeDef(meta: string, context: TypeGenerationContext): TypeGenerationResult {
    return { typeDef: '', fieldType: `: ${meta}` };
  }
}

/**
 * Factory to select the appropriate strategy
 */
export class TypeGenerationStrategyFactory {
  private static strategies: TypeGenerationStrategy[] = [
    new ZodTypeStrategy(),
    new ArchetypeTypeStrategy(),
    new LegacyTypeStrategy(),
    new PrimitiveTypeStrategy()
  ];

  static getStrategy(meta: any): TypeGenerationStrategy {
    for (const strategy of this.strategies) {
      if (strategy.canHandle(meta)) {
        return strategy;
      }
    }
    throw new Error(`No strategy found for meta: ${JSON.stringify(meta)}`);
  }
}