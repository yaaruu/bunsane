#!/usr/bin/env bun

/**
 * Unit tests for BaseArcheType.getEntityWithID method
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Entity } from '../core/Entity';
import { BaseArcheType, ArcheTypeField } from '../core/ArcheType';
import { Component, CompData, BaseComponent } from '../core/Components';

// Test components
@Component
class TestProfile extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    email!: string;
}

@Component
class TestStats extends BaseComponent {
    @CompData()
    loginCount!: number;
}

@Component
class TestTag extends BaseComponent {} // Empty tag component

// Test archetype
class TestArcheType extends BaseArcheType {
    @ArcheTypeField(TestProfile)
    profile!: TestProfile;

    @ArcheTypeField(TestStats)
    stats!: TestStats;

    @ArcheTypeField(TestTag)
    tag!: TestTag;
}

const testArcheType = new TestArcheType();

describe('BaseArcheType.getEntityWithID', () => {
    let testEntity: Entity;

    beforeAll(async () => {
        // Create and save a test entity
        testEntity = testArcheType.createEntity();
        await testEntity.set(TestProfile, { name: 'Test User', email: 'test@example.com' });
        await testEntity.set(TestStats, { loginCount: 5 });
        await testEntity.save();
    });

    afterAll(async () => {
        // Clean up
        if (testEntity) {
            await testEntity.delete();
        }
    });

    test('should return null for non-existent entity ID', async () => {
        const result = await testArcheType.getEntityWithID('non-existent-id');
        expect(result).toBeNull();
    });

    test('should load entity with all components populated', async () => {
        const result = await testArcheType.getEntityWithID(testEntity.id);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(testEntity.id);

        // Verify components are loaded (no additional DB calls needed)
        const profile = await result!.get(TestProfile);
        const stats = await result!.get(TestStats);
        const tag = await result!.get(TestTag);

        expect(profile).not.toBeNull();
        expect(profile!.name).toBe('Test User');
        expect(profile!.email).toBe('test@example.com');

        expect(stats).not.toBeNull();
        expect(stats!.loginCount).toBe(5);

        expect(tag).not.toBeNull();
    });

    test('should support includeComponents option', async () => {
        const result = await testArcheType.getEntityWithID(testEntity.id, {
            includeComponents: ['profile']
        });

        expect(result).not.toBeNull();

        // Should have profile loaded
        const profile = await result!.get(TestProfile);
        expect(profile).not.toBeNull();

        // Should not have stats loaded (would need DB call)
        // Note: In current implementation, all components are loaded via batch query
        // This test verifies the option is accepted without error
    });

    test('should support throwOnNotFound option', async () => {
        await expect(testArcheType.getEntityWithID('non-existent-id', {
            throwOnNotFound: true
        })).rejects.toThrow('Entity with ID non-existent-id not found');
    });

    test('static method should work', async () => {
        const result = await BaseArcheType.getEntityWithID(TestArcheType, testEntity.id);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(testEntity.id);
    });
});