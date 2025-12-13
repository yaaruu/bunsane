import { describe, it, expect, beforeEach } from '@jest/globals';
import { PrimitiveTypeStrategy } from '../../../gql/strategies/TypeGenerationStrategy';

describe('PrimitiveTypeStrategy', () => {
  let strategy: PrimitiveTypeStrategy;
  let definedInputTypes: Set<string>;
  let scalarTypes: Set<string>;

  beforeEach(() => {
    strategy = new PrimitiveTypeStrategy();
    definedInputTypes = new Set();
    scalarTypes = new Set();
  });

  describe('canHandle', () => {
    it('should return true for string primitives', () => {
      expect(strategy.canHandle('String!')).toBe(true);
      expect(strategy.canHandle('[Int]')).toBe(true);
      expect(strategy.canHandle('Boolean')).toBe(true);
    });

    it('should return false for non-string values', () => {
      expect(strategy.canHandle({})).toBe(false);
      expect(strategy.canHandle(123)).toBe(false);
      expect(strategy.canHandle(null)).toBe(false);
      expect(strategy.canHandle(undefined)).toBe(false);
    });
  });

  describe('generateTypeDef', () => {
    it('should return the primitive type as typeDef', () => {
      const result = strategy.generateTypeDef('String!', { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toBe('');
      expect(result.fieldType).toBe(': String!');
      expect(result.inputTypeName).toBeUndefined();
      expect(result.resolverWrapper).toBeUndefined();
    });

    it('should handle different primitive types', () => {
      expect(strategy.generateTypeDef('[Int]', { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes }).fieldType).toBe(': [Int]');
      expect(strategy.generateTypeDef('Boolean', { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes }).fieldType).toBe(': Boolean');
      expect(strategy.generateTypeDef('ID!', { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes }).fieldType).toBe(': ID!');
    });
  });
});