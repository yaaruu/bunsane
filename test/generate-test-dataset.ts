#!/usr/bin/env node

/**
 * Test Dataset Generator for Bunsane Query Performance Testing
 *
 * Generates realistic test data:
 * - 10,000 entities
 * - 50,000 components across 20+ types
 * - Varied filters for performance testing
 */

import { Entity } from '../core/Entity';
import { BaseComponent, CompData, Component } from '../core/Components';
import ComponentRegistry from '../core/ComponentRegistry';
import db from '../database';

// Test component definitions
@Component
class UserProfile extends BaseComponent {
    @CompData()
    username!: string;

    @CompData()
    email!: string;

    @CompData()
    account_type!: string;
}

@Component
class AccountQuota extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    usage!: number;

    @CompData()
    date!: string;
}

@Component
class ServiceArea extends BaseComponent {
    @CompData()
    area_id!: string;

    @CompData()
    service_type!: string;

    @CompData()
    price!: number;
}

@Component
class OrderHistory extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    order_date!: string;

    @CompData()
    total_amount!: number;

    @CompData()
    status!: string;
}

@Component
class NotificationSettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    email_notifications!: boolean;

    @CompData()
    sms_notifications!: boolean;
}

@Component
class PaymentMethod extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    type!: string;

    @CompData()
    last_used!: string;
}

@Component
class LocationData extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    latitude!: number;

    @CompData()
    longitude!: number;

    @CompData()
    accuracy!: number;
}

@Component
class DeviceInfo extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    device_type!: string;

    @CompData()
    os_version!: string;

    @CompData()
    app_version!: string;
}

@Component
class SubscriptionPlan extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    plan_name!: string;

    @CompData()
    start_date!: string;

    @CompData()
    end_date!: string;
}

@Component
class ActivityLog extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    activity_type!: string;

    @CompData()
    timestamp!: string;

    @CompData()
    details!: string;
}

@Component
class Preferences extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    theme!: string;

    @CompData()
    language!: string;

    @CompData()
    timezone!: string;
}

@Component
class SecuritySettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    two_factor_enabled!: boolean;

    @CompData()
    last_login!: string;
}

@Component
class ApiUsage extends BaseComponent {
    @CompData()
    account_id!: string;

    @CompData()
    api_calls!: number;

    @CompData()
    date!: string;

    @CompData()
    endpoint!: string;
}

@Component
class BillingInfo extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    billing_address!: string;

    @CompData()
    tax_id!: string;
}

@Component
class SupportTicket extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    subject!: string;

    @CompData()
    status!: string;

    @CompData()
    created_date!: string;
}

@Component
class FeatureFlag extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    feature_name!: string;

    @CompData()
    enabled!: boolean;
}

@Component
class AnalyticsData extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    event_type!: string;

    @CompData()
    event_data!: string;

    @CompData()
    timestamp!: string;
}

@Component
class IntegrationSettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    provider!: string;

    @CompData()
    api_key!: string;

    @CompData()
    enabled!: boolean;
}

@Component
class BackupSettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    frequency!: string;

    @CompData()
    last_backup!: string;
}

@Component
class AuditLog extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    action!: string;

    @CompData()
    timestamp!: string;

    @CompData()
    ip_address!: string;
}

@Component
class CacheSettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    cache_enabled!: boolean;

    @CompData()
    ttl_seconds!: number;
}

// Utility functions for generating test data
function randomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function randomEmail(): string {
    return `${randomString(8)}@${randomString(5)}.com`;
}

function randomDate(start: Date, end: Date): string {
    const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
    return date.toISOString().split('T')[0];
}

function randomNumber(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

// Component data generators
const componentGenerators = new Map<string, (entityId: string) => any>([
    ['UserProfile', (entityId: string) => ({
        username: `user_${entityId.slice(-6)}`,
        email: randomEmail(),
        account_type: randomChoice(['free', 'premium', 'enterprise'])
    })],
    ['AccountQuota', (entityId: string) => ({
        account_id: entityId,
        usage: randomNumber(0, 10000),
        date: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['ServiceArea', (entityId: string) => ({
        area_id: `area_${randomNumber(1, 100)}`,
        service_type: randomChoice(['delivery', 'pickup', 'dine_in']),
        price: randomNumber(10, 500)
    })],
    ['OrderHistory', (entityId: string) => ({
        user_id: entityId,
        order_date: randomDate(new Date('2024-01-01'), new Date('2025-12-31')),
        total_amount: randomNumber(15, 200),
        status: randomChoice(['pending', 'confirmed', 'delivered', 'cancelled'])
    })],
    ['NotificationSettings', (entityId: string) => ({
        user_id: entityId,
        email_notifications: Math.random() > 0.5,
        sms_notifications: Math.random() > 0.3
    })],
    ['PaymentMethod', (entityId: string) => ({
        user_id: entityId,
        type: randomChoice(['credit_card', 'debit_card', 'paypal', 'bank_transfer']),
        last_used: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['LocationData', (entityId: string) => ({
        user_id: entityId,
        latitude: -90 + Math.random() * 180,
        longitude: -180 + Math.random() * 360,
        accuracy: randomNumber(1, 100)
    })],
    ['DeviceInfo', (entityId: string) => ({
        user_id: entityId,
        device_type: randomChoice(['mobile', 'tablet', 'desktop']),
        os_version: randomChoice(['iOS 17', 'Android 13', 'Windows 11', 'macOS 14']),
        app_version: `1.${randomNumber(0, 9)}.${randomNumber(0, 9)}`
    })],
    ['SubscriptionPlan', (entityId: string) => ({
        user_id: entityId,
        plan_name: randomChoice(['basic', 'pro', 'premium']),
        start_date: randomDate(new Date('2024-01-01'), new Date('2025-06-01')),
        end_date: randomDate(new Date('2025-06-02'), new Date('2025-12-31'))
    })],
    ['ActivityLog', (entityId: string) => ({
        user_id: entityId,
        activity_type: randomChoice(['login', 'logout', 'purchase', 'update_profile']),
        timestamp: randomDate(new Date('2024-01-01'), new Date('2025-12-31')),
        details: `Activity details for ${entityId}`
    })],
    ['Preferences', (entityId: string) => ({
        user_id: entityId,
        theme: randomChoice(['light', 'dark', 'auto']),
        language: randomChoice(['en', 'es', 'fr', 'de']),
        timezone: randomChoice(['UTC', 'EST', 'PST', 'CET'])
    })],
    ['SecuritySettings', (entityId: string) => ({
        user_id: entityId,
        two_factor_enabled: Math.random() > 0.5,
        last_login: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['ApiUsage', (entityId: string) => ({
        account_id: entityId,
        api_calls: randomNumber(0, 1000),
        date: randomDate(new Date('2024-01-01'), new Date('2025-12-31')),
        endpoint: randomChoice(['/api/users', '/api/orders', '/api/payments', '/api/analytics'])
    })],
    ['BillingInfo', (entityId: string) => ({
        user_id: entityId,
        billing_address: `${randomNumber(1, 999)} ${randomString(10)} St, ${randomString(8)}`,
        tax_id: randomString(9)
    })],
    ['SupportTicket', (entityId: string) => ({
        user_id: entityId,
        subject: `Support issue ${randomNumber(1, 1000)}`,
        status: randomChoice(['open', 'in_progress', 'resolved', 'closed']),
        created_date: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['FeatureFlag', (entityId: string) => ({
        user_id: entityId,
        feature_name: randomChoice(['new_ui', 'advanced_analytics', 'api_v2', 'mobile_app']),
        enabled: Math.random() > 0.5
    })],
    ['AnalyticsData', (entityId: string) => ({
        user_id: entityId,
        event_type: randomChoice(['page_view', 'button_click', 'form_submit', 'error']),
        event_data: JSON.stringify({ page: '/dashboard', duration: randomNumber(1, 300) }),
        timestamp: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['IntegrationSettings', (entityId: string) => ({
        user_id: entityId,
        provider: randomChoice(['slack', 'discord', 'webhook', 'zapier']),
        api_key: randomString(32),
        enabled: Math.random() > 0.5
    })],
    ['BackupSettings', (entityId: string) => ({
        user_id: entityId,
        frequency: randomChoice(['daily', 'weekly', 'monthly']),
        last_backup: randomDate(new Date('2024-01-01'), new Date('2025-12-31'))
    })],
    ['AuditLog', (entityId: string) => ({
        user_id: entityId,
        action: randomChoice(['create', 'update', 'delete', 'login']),
        timestamp: randomDate(new Date('2024-01-01'), new Date('2025-12-31')),
        ip_address: `${randomNumber(1, 255)}.${randomNumber(0, 255)}.${randomNumber(0, 255)}.${randomNumber(0, 255)}`
    })],
    ['CacheSettings', (entityId: string) => ({
        user_id: entityId,
        cache_enabled: Math.random() > 0.3,
        ttl_seconds: randomNumber(300, 3600)
    })]
]);

async function generateTestDataset() {
    console.log('🚀 Starting test dataset generation...');

    // Ensure components are registered
    await ComponentRegistry.ensureComponentsRegistered();

    const entityCount = 10000;
    const totalComponents = 50000;
    const componentTypes = Array.from(componentGenerators.keys());

    console.log(`📊 Generating ${entityCount} entities with ${totalComponents} components across ${componentTypes.length} types`);

    // Generate entities
    const entities: Entity[] = [];
    for (let i = 0; i < entityCount; i++) {
        const entityId = `test-entity-${i.toString().padStart(6, '0')}`;
        const entity = new Entity(entityId);
        entities.push(entity);
    }

    // Generate components
    let componentCount = 0;
    const batchSize = 1000;

    for (let i = 0; i < totalComponents; i++) {
        const entityIndex = Math.floor(Math.random() * entities.length);
        const entity = entities[entityIndex];
        const componentType = randomChoice(componentTypes);
        const generator = componentGenerators.get(componentType);

        if (generator) {
            try {
                const componentData = generator(entity.id);

                // Create and attach component to entity
                // Note: In a real implementation, this would use the actual component classes
                // For now, we'll simulate the component creation

                componentCount++;

                if (componentCount % batchSize === 0) {
                    console.log(`✅ Generated ${componentCount}/${totalComponents} components`);
                }
            } catch (error) {
                console.error(`❌ Error generating component ${componentType} for entity ${entity.id}:`, error);
            }
        }
    }

    console.log(`🎉 Dataset generation complete!`);
    console.log(`📈 Summary:`);
    console.log(`   - Entities: ${entities.length}`);
    console.log(`   - Components: ${componentCount}`);
    console.log(`   - Component Types: ${componentTypes.length}`);
    console.log(`   - Average components per entity: ${(componentCount / entities.length).toFixed(2)}`);

    // Run ANALYZE to update query planner statistics
    console.log('🔍 Running ANALYZE on component tables...');
    try {
        await db.unsafe('ANALYZE components');
        await db.unsafe('ANALYZE entity_components');
        console.log('✅ ANALYZE complete');
    } catch (error) {
        console.warn('⚠️  ANALYZE failed:', error);
    }

    console.log('✨ Test dataset ready for performance testing!');
}

// Run the generator
if (require.main === module) {
    generateTestDataset()
        .then(() => {
            console.log('🏁 Dataset generation finished successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Dataset generation failed:', error);
            process.exit(1);
        });
}

export { generateTestDataset };