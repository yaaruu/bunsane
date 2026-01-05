#!/usr/bin/env bun

/**
 * Test for extended cache bypass options in bunsane Query system
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Entity } from '../core/Entity';
import { BaseArcheType, ArcheTypeField } from '../core/ArcheType';
import { Component, CompData, BaseComponent, ComponentRegistry } from '../core/components';
import { Query } from '../query/Query';
import db from '../database';

// Test components
@Component
class CacheBypassTestProfile extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    email!: string;
}

@Component
class CacheBypassTestSettings extends BaseComponent {
    @CompData()
    theme!: string;

    @CompData()
    notifications!: boolean;
}

// Test archetype
class CacheBypassTestArcheType extends BaseArcheType {
    @ArcheTypeField(CacheBypassTestProfile)
    profile!: CacheBypassTestProfile;

    @ArcheTypeField(CacheBypassTestSettings)
    settings!: CacheBypassTestSettings;
}

const testArcheType = new CacheBypassTestArcheType();

describe('Query Extended Cache Bypass Options', () => {
    let entity: Entity;

    beforeAll(async () => {
        // Ensure components are registered first
        await ComponentRegistry.ensureComponentsRegistered();
    });

    beforeEach(async () => {
        // Create test entity
        entity = testArcheType.createEntity();
        await entity.set(CacheBypassTestProfile, { name: 'Cache Test', email: 'cache@test.com' });
        await entity.set(CacheBypassTestSettings, { theme: 'dark', notifications: true });
        await entity.save();
    });

    afterEach(async () => {
        // Clean up test entity
        if (entity) {
            try {
                await entity.delete();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    test('noCache() should default to bypassing prepared statement cache', async () => {
        const query = new Query().findById(entity.id).noCache();

        // Check that skipPreparedCache is set
        expect((query as any).skipPreparedCache).toBe(true);
        expect((query as any).skipComponentCache).toBe(false);
    });

    test('noCache(options) should allow granular cache control', async () => {
        // Test bypassing only prepared statement cache
        const query1 = new Query().findById(entity.id).noCache({ preparedStatement: true });
        expect((query1 as any).skipPreparedCache).toBe(true);
        expect((query1 as any).skipComponentCache).toBe(false);

        // Test bypassing only component cache
        const query2 = new Query().findById(entity.id).noCache({ component: true });
        expect((query2 as any).skipPreparedCache).toBe(false);
        expect((query2 as any).skipComponentCache).toBe(true);

        // Test bypassing both caches
        const query3 = new Query().findById(entity.id).noCache({ preparedStatement: true, component: true });
        expect((query3 as any).skipPreparedCache).toBe(true);
        expect((query3 as any).skipComponentCache).toBe(true);

        // Test explicit false values
        const query4 = new Query().findById(entity.id).noCache({ preparedStatement: false, component: false });
        expect((query4 as any).skipPreparedCache).toBe(false);
        expect((query4 as any).skipComponentCache).toBe(false);
    });

    test('eagerLoadComponents should pass skipComponentCache to Entity.LoadComponents', async () => {
        // Spy on Entity.LoadComponents to verify the parameter
        const originalLoadComponents = Entity.LoadComponents;
        let capturedSkipCache = false;

        // Mock LoadComponents to capture the skipCache parameter
        (Entity as any).LoadComponents = async (entities: Entity[], componentIds: string[], skipCache: boolean = false) => {
            capturedSkipCache = skipCache;
            // Call original implementation
            return await originalLoadComponents.call(Entity, entities, componentIds, skipCache);
        };

        try {
            // Test with cache bypass enabled
            const query1 = new Query()
                .findById(entity.id)
                .noCache({ component: true })
                .eagerLoadComponents([CacheBypassTestProfile]);

            await query1.exec();
            expect(capturedSkipCache).toBe(true);

            // Test with cache bypass disabled
            capturedSkipCache = false;
            const query2 = new Query()
                .findById(entity.id)
                .eagerLoadComponents([CacheBypassTestProfile]);

            await query2.exec();
            expect(capturedSkipCache).toBe(false);

        } finally {
            // Restore original method
            (Entity as any).LoadComponents = originalLoadComponents;
        }
    });

    test('queries should execute successfully with cache bypass options', async () => {
        // Test exec() with prepared statement cache bypass
        const results1 = await new Query()
            .findById(entity.id)
            .noCache({ preparedStatement: true })
            .exec();

        expect(results1).toHaveLength(1);
        expect(results1[0]!.id).toBe(entity.id);

        // Test count() with prepared statement cache bypass
        const count1 = await new Query()
            .findById(entity.id)
            .noCache({ preparedStatement: true })
            .count();

        expect(count1).toBe(1);

        // Test with component cache bypass
        const results2 = await new Query()
            .findById(entity.id)
            .noCache({ component: true })
            .eagerLoadComponents([CacheBypassTestProfile])
            .exec();

        expect(results2).toHaveLength(1);
        expect(results2[0]!.id).toBe(entity.id);
    });
});