import { describe, it, expect, beforeEach } from '@jest/globals';
import { TypeGenerationStrategyFactory } from '../../../gql/strategies/TypeGenerationStrategy';
import { z } from 'zod';
import BaseArcheType from '../../../core/ArcheType';

describe('TypeGenerationStrategyFactory', () => {
  describe('getStrategy', () => {
    it('should return ZodTypeStrategy for Zod schemas', () => {
      const schema = z.object({ name: z.string() });
      const strategy = TypeGenerationStrategyFactory.getStrategy(schema);

      expect(strategy.constructor.name).toBe('ZodTypeStrategy');
    });

    it('should return ArchetypeTypeStrategy for BaseArcheType instances', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      const strategy = TypeGenerationStrategyFactory.getStrategy(mockArchetype);

      expect(strategy.constructor.name).toBe('ArchetypeTypeStrategy');
    });

    it('should return ArchetypeTypeStrategy for arrays of BaseArcheType', () => {
      const mockArchetype = Object.create(BaseArcheType.prototype);
      mockArchetype.constructor = { name: 'TestArcheType' };

      const strategy = TypeGenerationStrategyFactory.getStrategy([mockArchetype]);

      expect(strategy.constructor.name).toBe('ArchetypeTypeStrategy');
    });

    it('should return LegacyTypeStrategy for plain objects', () => {
      const meta = { name: 'String!', age: 'Int!' };
      const strategy = TypeGenerationStrategyFactory.getStrategy(meta);

      expect(strategy.constructor.name).toBe('LegacyTypeStrategy');
    });

    it('should return PrimitiveTypeStrategy for strings', () => {
      const strategy = TypeGenerationStrategyFactory.getStrategy('String!');

      expect(strategy.constructor.name).toBe('PrimitiveTypeStrategy');
    });

    it('should throw error for unsupported types', () => {
      expect(() => TypeGenerationStrategyFactory.getStrategy(123)).toThrow('No strategy found');
      expect(() => TypeGenerationStrategyFactory.getStrategy(null)).toThrow('No strategy found');
      expect(() => TypeGenerationStrategyFactory.getStrategy(undefined)).toThrow('No strategy found');
    });
  });
});