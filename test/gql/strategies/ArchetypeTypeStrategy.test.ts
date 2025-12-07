import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ArchetypeTypeStrategy } from '../../../gql/strategies/TypeGenerationStrategy';
import BaseArcheType from '../../../core/ArcheType';

describe('ArchetypeTypeStrategy', () => {
  let strategy: ArchetypeTypeStrategy;
  let definedInputTypes: Set<string>;
  let scalarTypes: Set<string>;

  beforeEach(() => {
    strategy = new ArchetypeTypeStrategy();
    definedInputTypes = new Set();
    scalarTypes = new Set();
  });

  describe('canHandle', () => {
    it('should return true for BaseArcheType instances', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      expect(strategy.canHandle(mockArchetype)).toBe(true);
    });

    it('should return true for arrays of BaseArcheType instances', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      expect(strategy.canHandle([mockArchetype])).toBe(true);
    });

    it('should return false for non-archetype objects', () => {
      expect(strategy.canHandle({ name: 'String' })).toBe(false);
      expect(strategy.canHandle('String')).toBe(false);
      expect(strategy.canHandle(null)).toBe(false);
    });
  });

  describe('generateTypeDef', () => {
    it('should generate type definition for single archetype', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      // Mock getArchetypeTypeName
      const mockGetArchetypeTypeName = jest.fn().mockReturnValue('TestType');
      jest.doMock('../../../core/ArcheType', () => ({
        ...jest.requireActual('../../../core/ArcheType'),
        getArchetypeTypeName: mockGetArchetypeTypeName
      }));

      const result = strategy.generateTypeDef(mockArchetype, { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toBe('');
      expect(result.fieldType).toBe(': TestType');
      expect(mockGetArchetypeTypeName).toHaveBeenCalledWith(mockArchetype);
    });

    it('should generate type definition for array of archetypes', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      const mockGetArchetypeTypeName = jest.fn().mockReturnValue('TestType');
      jest.doMock('../../../core/ArcheType', () => ({
        ...jest.requireActual('../../../core/ArcheType'),
        getArchetypeTypeName: mockGetArchetypeTypeName
      }));

      const result = strategy.generateTypeDef([mockArchetype], { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toBe('');
      expect(result.fieldType).toBe(': [TestType]');
      expect(mockGetArchetypeTypeName).toHaveBeenCalledWith(mockArchetype);
    });

    it('should handle invalid archetype gracefully', () => {
      const invalidArchetype = Object.create(BaseArcheType.prototype);
      invalidArchetype.constructor = { name: 'TestArcheType' };

      const mockGetArchetypeTypeName = jest.fn().mockReturnValue(null);
      jest.doMock('../../../core/ArcheType', () => ({
        ...jest.requireActual('../../../core/ArcheType'),
        getArchetypeTypeName: mockGetArchetypeTypeName
      }));

      const result = strategy.generateTypeDef(invalidArchetype, { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toBe('');
      expect(result.fieldType).toBe(': Any');
    });

    it('should handle invalid array archetype gracefully', () => {
      const invalidArchetype = Object.create(BaseArcheType.prototype);
      invalidArchetype.constructor = { name: 'TestArcheType' };

      const mockGetArchetypeTypeName = jest.fn().mockReturnValue(null);
      jest.doMock('../../../core/ArcheType', () => ({
        ...jest.requireActual('../../../core/ArcheType'),
        getArchetypeTypeName: mockGetArchetypeTypeName
      }));

      const result = strategy.generateTypeDef([invalidArchetype], { operationName: 'TestOperation', isInput: false, definedInputTypes, scalarTypes });

      expect(result.typeDef).toBe('');
      expect(result.fieldType).toBe(': [Any]');
    });
  });
});