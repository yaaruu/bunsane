import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ZodTypeStrategy } from '../../../gql/strategies/TypeGenerationStrategy';
import { z } from 'zod';

describe('ZodTypeStrategy', () => {
  let strategy: ZodTypeStrategy;
  let definedInputTypes: Set<string>;
  let scalarTypes: Set<string>;

  beforeEach(() => {
    strategy = new ZodTypeStrategy();
    definedInputTypes = new Set();
    scalarTypes = new Set(['CustomScalar']);
  });

  describe('canHandle', () => {
    it('should return true for Zod schemas', () => {
      const schema = z.object({ name: z.string() });
      expect(strategy.canHandle(schema)).toBe(true);
    });

    it('should return false for non-Zod objects', () => {
      expect(strategy.canHandle({ name: 'String' })).toBe(false);
      expect(strategy.canHandle('String')).toBe(false);
      expect(strategy.canHandle(null)).toBe(false);
    });
  });

  describe('generateTypeDef', () => {
    it('should generate input type definition for simple Zod object', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number()
      });

      const result = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });

      expect(result.typeDef).toContain('input TestOperationInput');
      expect(result.typeDef).toContain('name: String!');
      expect(result.typeDef).toContain('age: Float!');
      expect(result.inputTypeName).toBe('TestOperationInput');
      expect(typeof result.resolverWrapper).toBe('function');
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().optional()
      });

      const result = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });

      expect(result.typeDef).toContain('input TestOperationInput');
      expect(result.typeDef).toContain('name: String!');
      expect(result.typeDef).toContain('age: Float');
    });

    it('should handle unions with scalar literals', () => {
      scalarTypes.add('Status');
      const schema = z.object({
        status: z.union([z.literal('active'), z.literal('inactive')])
      });

      const result = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });

      expect(result.typeDef).toContain('status: Status!');
    });

    it('should deduplicate input types', () => {
      const schema = z.object({ name: z.string() });

      strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });
      const result2 = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });

      expect(result2.typeDef.trim()).toBe(''); // Should be empty due to deduplication
    });
  });

  describe('resolverWrapper', () => {
    it('should validate input with Zod schema', async () => {
      const schema = z.object({
        name: z.string().min(1),
        age: z.number().min(0)
      });

      const result = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });
      const mockResolver = jest.fn().mockResolvedValue('success');

      const wrappedResolver = result.resolverWrapper!(mockResolver);

      await wrappedResolver(null, { input: { name: 'John', age: 30 } }, {}, {});

      expect(mockResolver).toHaveBeenCalledWith({ name: 'John', age: 30 }, {}, {});
    });

    it('should throw error for invalid input', async () => {
      const schema = z.object({
        name: z.string().min(1)
      });

      const result = strategy.generateTypeDef(schema, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });
      const mockResolver = jest.fn();

      const wrappedResolver = result.resolverWrapper!(mockResolver);

      await expect(wrappedResolver(null, { input: { name: '' } }, {}, {})).rejects.toThrow();
      expect(mockResolver).not.toHaveBeenCalled();
    });
  });
});