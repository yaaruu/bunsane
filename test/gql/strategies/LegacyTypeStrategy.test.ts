import { describe, it, expect, beforeEach } from '@jest/globals';
import { LegacyTypeStrategy } from '../../../gql/strategies/TypeGenerationStrategy';

describe('LegacyTypeStrategy', () => {
  let strategy: LegacyTypeStrategy;
  let definedInputTypes: Set<string>;
  let scalarTypes: Set<string>;

  beforeEach(() => {
    strategy = new LegacyTypeStrategy();
    definedInputTypes = new Set();
    scalarTypes = new Set();
  });

  describe('canHandle', () => {
    it('should return true for plain objects that are not Zod schemas', () => {
      const meta = { name: 'String!', age: 'Int!' };
      expect(strategy.canHandle(meta)).toBe(true);
    });

    it('should return false for Zod schemas', () => {
      const meta = { _def: {} }; // Mock Zod schema
      expect(strategy.canHandle(meta)).toBe(false);
    });

    it('should return false for archetypes', () => {
      // Mock archetype check - since we can't easily mock BaseArcheType, test with string
      expect(strategy.canHandle('String')).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(strategy.canHandle('String!')).toBe(false);
    });
  });

  describe('generateTypeDef', () => {
    it('should generate input type definition for input-like objects', () => {
      const meta = { name: 'String!', age: 'Int!' };

      const result = strategy.generateTypeDef(meta, { operationName: 'TestOperation', isInput: true, definedInputTypes, scalarTypes });

      expect(result.typeDef).toContain('input TestOperationInput {');
      expect(result.typeDef).toContain('name: String!');
      expect(result.typeDef).toContain('age: Int!');
      expect(result.inputTypeName).toBe('TestOperationInput');
    });

    it('should generate output type definition for output-like objects', () => {
      const meta = { result: 'String!', count: 'Int!' };

      const result = strategy.generateTypeDef(meta, { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toContain('type TestOperationOutput {');
      expect(result.typeDef).toContain('result: String!');
      expect(result.typeDef).toContain('count: Int!');
    });
  });
});