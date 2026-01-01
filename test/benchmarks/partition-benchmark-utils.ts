import { Query, or } from '../../query/Query';
import ComponentRegistry from '../../core/ComponentRegistry';
import { PrepareDatabase, GetPartitionStrategy } from '../../database/DatabaseHelper';
import { BaseComponent, CompData, Component } from '../../core/Components';
import { Entity } from '../../core/Entity';
import db from '../../database';
import { config } from '../../core/Config';

// Import generated components (Comp1-Comp100)
import { 
    AllGeneratedComponents, 
    componentDataGenerators,
    AllGeneratedComponentNames 
} from './generated-components';

// Create a map of component name to constructor from generated components
const generatedComponentMap = new Map<string, new () => BaseComponent>();
for (let i = 0; i < AllGeneratedComponents.length; i++) {
    const name = AllGeneratedComponentNames[i];
    if (name) {
        generatedComponentMap.set(name, AllGeneratedComponents[i] as unknown as new () => BaseComponent);
    }
}

// Benchmark result types
export interface BenchmarkResult {
    strategy: 'list' | 'hash';
    useDirectPartition: boolean;
    queryType: string;
    planningTimeMs: number;
    executionTimeMs: number;
    totalTimeMs: number;
    rowsReturned: number;
    bufferHits: number;
    bufferReads: number;
    bufferHitRatio: number;
    timestamp: Date;
}

// Test component definitions for benchmarking
@Component
class BenchmarkUser extends BaseComponent {
    @CompData()
    username!: string;

    @CompData()
    email!: string;

    @CompData()
    account_type!: string;
}

@Component
class BenchmarkOrder extends BaseComponent {
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
class BenchmarkProduct extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    category!: string;

    @CompData()
    price!: number;

    @CompData()
    in_stock!: boolean;
}

@Component
class BenchmarkLocation extends BaseComponent {
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
class BenchmarkActivity extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    activity_type!: string;

    @CompData()
    timestamp!: string;
}

// Additional predefined component classes for large-scale testing
@Component
class BenchmarkProfile extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    bio!: string;

    @CompData()
    avatar_url!: string;

    @CompData()
    website!: string;
}

@Component
class BenchmarkSettings extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    theme!: string;

    @CompData()
    language!: string;

    @CompData()
    notifications_enabled!: boolean;
}

@Component
class BenchmarkAnalytics extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    page_views!: number;

    @CompData()
    session_duration!: number;

    @CompData()
    last_active!: string;
}

@Component
class BenchmarkMetadata extends BaseComponent {
    @CompData()
    entity_id!: string;

    @CompData()
    tags!: string;

    @CompData()
    category!: string;

    @CompData()
    version!: number;
}

@Component
class BenchmarkCache extends BaseComponent {
    @CompData()
    key!: string;

    @CompData()
    value!: string;

    @CompData()
    expires_at!: string;

    @CompData()
    hits!: number;
}

@Component
class BenchmarkSession extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    session_id!: string;

    @CompData()
    ip_address!: string;

    @CompData()
    user_agent!: string;
}

@Component
class BenchmarkAudit extends BaseComponent {
    @CompData()
    entity_id!: string;

    @CompData()
    action!: string;

    @CompData()
    performed_by!: string;

    @CompData()
    timestamp!: string;
}

@Component
class BenchmarkMetrics extends BaseComponent {
    @CompData()
    entity_id!: string;

    @CompData()
    metric_name!: string;

    @CompData()
    value!: number;

    @CompData()
    unit!: string;
}

@Component
class BenchmarkConfig extends BaseComponent {
    @CompData()
    entity_id!: string;

    @CompData()
    config_key!: string;

    @CompData()
    config_value!: string;

    @CompData()
    is_active!: boolean;
}

@Component
class BenchmarkPermissions extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    resource!: string;

    @CompData()
    permission!: string;

    @CompData()
    granted_at!: string;
}

@Component
class BenchmarkNotification extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    type!: string;

    @CompData()
    message!: string;

    @CompData()
    read!: boolean;

    @CompData()
    created_at!: string;
}

@Component
class BenchmarkSubscription extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    plan!: string;

    @CompData()
    status!: string;

    @CompData()
    expires_at!: string;

    @CompData()
    auto_renew!: boolean;
}

@Component
class BenchmarkPayment extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    amount!: number;

    @CompData()
    currency!: string;

    @CompData()
    method!: string;

    @CompData()
    transaction_id!: string;
}

@Component
class BenchmarkInventory extends BaseComponent {
    @CompData()
    product_id!: string;

    @CompData()
    warehouse_id!: string;

    @CompData()
    quantity!: number;

    @CompData()
    location!: string;

    @CompData()
    last_updated!: string;
}

@Component
class BenchmarkReview extends BaseComponent {
    @CompData()
    product_id!: string;

    @CompData()
    user_id!: string;

    @CompData()
    rating!: number;

    @CompData()
    comment!: string;

    @CompData()
    verified!: boolean;
}

@Component
class BenchmarkWishlist extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    product_id!: string;

    @CompData()
    added_at!: string;

    @CompData()
    priority!: string;
}

@Component
class BenchmarkCart extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    session_id!: string;

    @CompData()
    items!: string; // JSON array of cart items

    @CompData()
    total!: number;

    @CompData()
    last_modified!: string;
}

@Component
class BenchmarkAddress extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    type!: string; // billing, shipping, etc.

    @CompData()
    street!: string;

    @CompData()
    city!: string;

    @CompData()
    state!: string;

    @CompData()
    zip_code!: string;

    @CompData()
    country!: string;
}

@Component
class BenchmarkDevice extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    device_id!: string;

    @CompData()
    type!: string;

    @CompData()
    os!: string;

    @CompData()
    app_version!: string;

    @CompData()
    last_seen!: string;
}

@Component
class BenchmarkLog extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    action!: string;

    @CompData()
    details!: string;

    @CompData()
    ip_address!: string;

    @CompData()
    timestamp!: string;

    @CompData()
    severity!: string;
}

@Component
class BenchmarkBookmark extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    url!: string;

    @CompData()
    title!: string;

    @CompData()
    tags!: string;

    @CompData()
    created_at!: string;
}

@Component
class BenchmarkMessage extends BaseComponent {
    @CompData()
    sender_id!: string;

    @CompData()
    receiver_id!: string;

    @CompData()
    content!: string;

    @CompData()
    type!: string;

    @CompData()
    sent_at!: string;

    @CompData()
    read_at!: string;
}

@Component
class BenchmarkFile extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    filename!: string;

    @CompData()
    size!: number;

    @CompData()
    mime_type!: string;

    @CompData()
    path!: string;

    @CompData()
    uploaded_at!: string;
}

@Component
class BenchmarkCategory extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    parent_id!: string;

    @CompData()
    description!: string;

    @CompData()
    sort_order!: number;

    @CompData()
    is_active!: boolean;
}

@Component
class BenchmarkTag extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    color!: string;

    @CompData()
    usage_count!: number;

    @CompData()
    created_by!: string;
}

@Component
class BenchmarkComment extends BaseComponent {
    @CompData()
    entity_id!: string;

    @CompData()
    user_id!: string;

    @CompData()
    content!: string;

    @CompData()
    parent_id!: string;

    @CompData()
    created_at!: string;

    @CompData()
    moderated!: boolean;
}

@Component
class BenchmarkVote extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    entity_id!: string;

    @CompData()
    entity_type!: string;

    @CompData()
    vote_type!: string; // up, down

    @CompData()
    voted_at!: string;
}

@Component
class BenchmarkReport extends BaseComponent {
    @CompData()
    reporter_id!: string;

    @CompData()
    entity_id!: string;

    @CompData()
    reason!: string;

    @CompData()
    description!: string;

    @CompData()
    status!: string;

    @CompData()
    created_at!: string;
}

@Component
class BenchmarkBackup extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    backup_id!: string;

    @CompData()
    size!: number;

    @CompData()
    created_at!: string;

    @CompData()
    expires_at!: string;

    @CompData()
    status!: string;
}

@Component
class BenchmarkIntegration extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    provider!: string;

    @CompData()
    external_id!: string;

    @CompData()
    access_token!: string;

    @CompData()
    refresh_token!: string;

    @CompData()
    expires_at!: string;
}

@Component
class BenchmarkSchedule extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    title!: string;

    @CompData()
    description!: string;

    @CompData()
    start_time!: string;

    @CompData()
    end_time!: string;

    @CompData()
    recurring!: boolean;
}

@Component
class BenchmarkTask extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    title!: string;

    @CompData()
    description!: string;

    @CompData()
    priority!: string;

    @CompData()
    due_date!: string;

    @CompData()
    completed!: boolean;
}

@Component
class BenchmarkProject extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    owner_id!: string;

    @CompData()
    description!: string;

    @CompData()
    status!: string;

    @CompData()
    created_at!: string;

    @CompData()
    deadline!: string;
}

@Component
class BenchmarkTeam extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    owner_id!: string;

    @CompData()
    members!: string; // JSON array

    @CompData()
    created_at!: string;

    @CompData()
    is_active!: boolean;
}

@Component
class BenchmarkRole extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    permissions!: string; // JSON array

    @CompData()
    level!: number;

    @CompData()
    description!: string;
}

@Component
class BenchmarkApiKey extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    name!: string;

    @CompData()
    key!: string;

    @CompData()
    permissions!: string; // JSON array

    @CompData()
    expires_at!: string;

    @CompData()
    last_used!: string;
}

@Component
class BenchmarkWebhook extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    url!: string;

    @CompData()
    events!: string; // JSON array

    @CompData()
    secret!: string;

    @CompData()
    is_active!: boolean;
}

@Component
class BenchmarkTemplate extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    type!: string;

    @CompData()
    content!: string;

    @CompData()
    variables!: string; // JSON object

    @CompData()
    created_by!: string;
}

@Component
class BenchmarkWorkflow extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    steps!: string; // JSON array

    @CompData()
    triggers!: string; // JSON array

    @CompData()
    is_active!: boolean;

    @CompData()
    created_by!: string;
}

@Component
class BenchmarkAlert extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    type!: string;

    @CompData()
    condition!: string;

    @CompData()
    threshold!: number;

    @CompData()
    is_active!: boolean;
}

@Component
class BenchmarkMetric extends BaseComponent {
    @CompData()
    name!: string;

    @CompData()
    value!: number;

    @CompData()
    unit!: string;

    @CompData()
    timestamp!: string;

    @CompData()
    source!: string;
}

@Component
class BenchmarkQuota extends BaseComponent {
    @CompData()
    user_id!: string;

    @CompData()
    resource!: string;

    @CompData()
    limit!: number;

    @CompData()
    used!: number;

    @CompData()
    reset_date!: string;
}

// Define simple component types for benchmarking
// Comp1 through Comp100 with basic properties
@Component
class Comp1 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp2 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp3 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp4 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp5 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp6 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp7 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp8 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp9 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp10 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

// Add more components up to Comp100 (showing pattern, would continue...)
@Component
class Comp11 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp12 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp13 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp14 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp15 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp16 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp17 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp18 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp19 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp20 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp21 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp22 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp23 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp24 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

@Component
class Comp25 extends BaseComponent {
    @CompData()
    entity_id!: string;
    @CompData()
    value1!: string;
    @CompData()
    value2!: number;
    @CompData()
    value3!: boolean;
    @CompData()
    timestamp!: string;
}

// Dynamic component generation for large-scale testing
interface ComponentDefinition {
    name: string;
    properties: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean';
        generator: () => any;
    }>;
    frequency: number; // How often this component appears (0-1)
}

function generateComponentDefinitions(count: number = 100): ComponentDefinition[] {
    const definitions: ComponentDefinition[] = [];

    // Generate simple component definitions for Comp1 through Comp100
    const predefinedComponents = [];

    for (let i = 1; i <= 100; i++) {
        predefinedComponents.push({
            name: `Comp${i}`,
            properties: [
                { name: 'entity_id', type: 'string' as const, generator: () => `entity_${Math.floor(Math.random() * 10000)}` },
                { name: 'value1', type: 'string' as const, generator: () => `data_${Math.random().toString(36).substr(2, 8)}` },
                { name: 'value2', type: 'number' as const, generator: () => Math.floor(Math.random() * 1000) },
                { name: 'value3', type: 'boolean' as const, generator: () => Math.random() > 0.5 },
                { name: 'timestamp', type: 'string' as const, generator: () => new Date().toISOString() }
            ],
            frequency: 0.1 + Math.random() * 0.2 // Random frequency between 0.1 and 0.3
        });
    }

    // Use predefined components - we have 15 different component types for comprehensive testing
    definitions.push(...predefinedComponents);

    return definitions.slice(0, count); // Ensure we don't exceed the requested count
}

// Helper function to create component instances dynamically
function createComponentInstance(def: ComponentDefinition, entityId: string): BaseComponent {
    // For predefined components, use the actual class constructors
    switch (def.name) {
        case 'BenchmarkUser':
            const userComp = new BenchmarkUser();
            userComp.username = def.properties[0].generator();
            userComp.email = def.properties[1].generator();
            userComp.account_type = def.properties[2].generator();
            return userComp;

        case 'BenchmarkOrder':
            const orderComp = new BenchmarkOrder();
            orderComp.user_id = def.properties[0].generator();
            orderComp.order_date = def.properties[1].generator();
            orderComp.total_amount = def.properties[2].generator();
            orderComp.status = def.properties[3].generator();
            return orderComp;

        case 'BenchmarkProduct':
            const productComp = new BenchmarkProduct();
            productComp.name = def.properties[0].generator();
            productComp.category = def.properties[1].generator();
            productComp.price = def.properties[2].generator();
            productComp.in_stock = def.properties[3].generator();
            return productComp;

        case 'BenchmarkLocation':
            const locationComp = new BenchmarkLocation();
            locationComp.user_id = def.properties[0].generator();
            locationComp.latitude = def.properties[1].generator();
            locationComp.longitude = def.properties[2].generator();
            locationComp.accuracy = def.properties[3].generator();
            return locationComp;

        case 'BenchmarkActivity':
            const activityComp = new BenchmarkActivity();
            activityComp.user_id = def.properties[0].generator();
            activityComp.activity_type = def.properties[1].generator();
            activityComp.timestamp = def.properties[2].generator();
            return activityComp;

        case 'BenchmarkProfile':
            const profileComp = new BenchmarkProfile();
            profileComp.user_id = def.properties[0].generator();
            profileComp.bio = def.properties[1].generator();
            profileComp.avatar_url = def.properties[2].generator();
            profileComp.website = def.properties[3].generator();
            return profileComp;

        case 'BenchmarkSettings':
            const settingsComp = new BenchmarkSettings();
            settingsComp.user_id = def.properties[0].generator();
            settingsComp.theme = def.properties[1].generator();
            settingsComp.language = def.properties[2].generator();
            settingsComp.notifications_enabled = def.properties[3].generator();
            return settingsComp;

        case 'BenchmarkAnalytics':
            const analyticsComp = new BenchmarkAnalytics();
            analyticsComp.user_id = def.properties[0].generator();
            analyticsComp.page_views = def.properties[1].generator();
            analyticsComp.session_duration = def.properties[2].generator();
            analyticsComp.last_active = def.properties[3].generator();
            return analyticsComp;

        case 'BenchmarkMetadata':
            const metadataComp = new BenchmarkMetadata();
            metadataComp.entity_id = def.properties[0].generator();
            metadataComp.tags = def.properties[1].generator();
            metadataComp.category = def.properties[2].generator();
            metadataComp.version = def.properties[3].generator();
            return metadataComp;

        case 'BenchmarkCache':
            const cacheComp = new BenchmarkCache();
            cacheComp.key = def.properties[0].generator();
            cacheComp.value = def.properties[1].generator();
            cacheComp.expires_at = def.properties[2].generator();
            cacheComp.hits = def.properties[3].generator();
            return cacheComp;

        case 'BenchmarkSession':
            const sessionComp = new BenchmarkSession();
            sessionComp.user_id = def.properties[0].generator();
            sessionComp.session_id = def.properties[1].generator();
            sessionComp.ip_address = def.properties[2].generator();
            sessionComp.user_agent = def.properties[3].generator();
            return sessionComp;

        case 'BenchmarkAudit':
            const auditComp = new BenchmarkAudit();
            auditComp.entity_id = def.properties[0].generator();
            auditComp.action = def.properties[1].generator();
            auditComp.performed_by = def.properties[2].generator();
            auditComp.timestamp = def.properties[3].generator();
            return auditComp;

        case 'BenchmarkMetrics':
            const metricsComp = new BenchmarkMetrics();
            metricsComp.entity_id = def.properties[0].generator();
            metricsComp.metric_name = def.properties[1].generator();
            metricsComp.value = def.properties[2].generator();
            metricsComp.unit = def.properties[3].generator();
            return metricsComp;

        case 'BenchmarkConfig':
            const configComp = new BenchmarkConfig();
            configComp.entity_id = def.properties[0].generator();
            configComp.config_key = def.properties[1].generator();
            configComp.config_value = def.properties[2].generator();
            configComp.is_active = def.properties[3].generator();
            return configComp;

        case 'BenchmarkPermissions':
            const permissionsComp = new BenchmarkPermissions();
            permissionsComp.user_id = def.properties[0].generator();
            permissionsComp.resource = def.properties[1].generator();
            permissionsComp.permission = def.properties[2].generator();
            permissionsComp.granted_at = def.properties[3].generator();
            return permissionsComp;

        case 'BenchmarkNotification':
            const notificationComp = new BenchmarkNotification();
            notificationComp.user_id = def.properties[0].generator();
            notificationComp.type = def.properties[1].generator();
            notificationComp.message = def.properties[2].generator();
            notificationComp.read = def.properties[3].generator();
            notificationComp.created_at = def.properties[4].generator();
            return notificationComp;

        case 'BenchmarkSubscription':
            const subscriptionComp = new BenchmarkSubscription();
            subscriptionComp.user_id = def.properties[0].generator();
            subscriptionComp.plan = def.properties[1].generator();
            subscriptionComp.status = def.properties[2].generator();
            subscriptionComp.expires_at = def.properties[3].generator();
            subscriptionComp.auto_renew = def.properties[4].generator();
            return subscriptionComp;

        case 'BenchmarkPayment':
            const paymentComp = new BenchmarkPayment();
            paymentComp.user_id = def.properties[0].generator();
            paymentComp.amount = def.properties[1].generator();
            paymentComp.currency = def.properties[2].generator();
            paymentComp.method = def.properties[3].generator();
            paymentComp.transaction_id = def.properties[4].generator();
            return paymentComp;

        case 'BenchmarkInventory':
            const inventoryComp = new BenchmarkInventory();
            inventoryComp.product_id = def.properties[0].generator();
            inventoryComp.warehouse_id = def.properties[1].generator();
            inventoryComp.quantity = def.properties[2].generator();
            inventoryComp.location = def.properties[3].generator();
            inventoryComp.last_updated = def.properties[4].generator();
            return inventoryComp;

        case 'BenchmarkReview':
            const reviewComp = new BenchmarkReview();
            reviewComp.product_id = def.properties[0].generator();
            reviewComp.user_id = def.properties[1].generator();
            reviewComp.rating = def.properties[2].generator();
            reviewComp.comment = def.properties[3].generator();
            reviewComp.verified = def.properties[4].generator();
            return reviewComp;

        case 'BenchmarkWishlist':
            const wishlistComp = new BenchmarkWishlist();
            wishlistComp.user_id = def.properties[0].generator();
            wishlistComp.product_id = def.properties[1].generator();
            wishlistComp.added_at = def.properties[2].generator();
            wishlistComp.priority = def.properties[3].generator();
            return wishlistComp;

        case 'BenchmarkCart':
            const cartComp = new BenchmarkCart();
            cartComp.user_id = def.properties[0].generator();
            cartComp.session_id = def.properties[1].generator();
            cartComp.items = def.properties[2].generator();
            cartComp.total = def.properties[3].generator();
            cartComp.last_modified = def.properties[4].generator();
            return cartComp;

        case 'BenchmarkAddress':
            const addressComp = new BenchmarkAddress();
            addressComp.user_id = def.properties[0].generator();
            addressComp.type = def.properties[1].generator();
            addressComp.street = def.properties[2].generator();
            addressComp.city = def.properties[3].generator();
            addressComp.state = def.properties[4].generator();
            addressComp.zip_code = def.properties[5].generator();
            addressComp.country = def.properties[6].generator();
            return addressComp;

        case 'BenchmarkDevice':
            const deviceComp = new BenchmarkDevice();
            deviceComp.user_id = def.properties[0].generator();
            deviceComp.device_id = def.properties[1].generator();
            deviceComp.type = def.properties[2].generator();
            deviceComp.os = def.properties[3].generator();
            deviceComp.app_version = def.properties[4].generator();
            deviceComp.last_seen = def.properties[5].generator();
            return deviceComp;

        case 'BenchmarkLog':
            const logComp = new BenchmarkLog();
            logComp.user_id = def.properties[0].generator();
            logComp.action = def.properties[1].generator();
            logComp.details = def.properties[2].generator();
            logComp.ip_address = def.properties[3].generator();
            logComp.timestamp = def.properties[4].generator();
            logComp.severity = def.properties[5].generator();
            return logComp;

        case 'BenchmarkBookmark':
            const bookmarkComp = new BenchmarkBookmark();
            bookmarkComp.user_id = def.properties[0].generator();
            bookmarkComp.url = def.properties[1].generator();
            bookmarkComp.title = def.properties[2].generator();
            bookmarkComp.tags = def.properties[3].generator();
            bookmarkComp.created_at = def.properties[4].generator();
            return bookmarkComp;

        case 'BenchmarkMessage':
            const messageComp = new BenchmarkMessage();
            messageComp.sender_id = def.properties[0].generator();
            messageComp.receiver_id = def.properties[1].generator();
            messageComp.content = def.properties[2].generator();
            messageComp.type = def.properties[3].generator();
            messageComp.sent_at = def.properties[4].generator();
            messageComp.read_at = def.properties[5].generator();
            return messageComp;

        case 'BenchmarkFile':
            const fileComp = new BenchmarkFile();
            fileComp.user_id = def.properties[0].generator();
            fileComp.filename = def.properties[1].generator();
            fileComp.size = def.properties[2].generator();
            fileComp.mime_type = def.properties[3].generator();
            fileComp.path = def.properties[4].generator();
            fileComp.uploaded_at = def.properties[5].generator();
            return fileComp;

        case 'BenchmarkCategory':
            const categoryComp = new BenchmarkCategory();
            categoryComp.name = def.properties[0].generator();
            categoryComp.parent_id = def.properties[1].generator();
            categoryComp.description = def.properties[2].generator();
            categoryComp.sort_order = def.properties[3].generator();
            categoryComp.is_active = def.properties[4].generator();
            return categoryComp;

        case 'BenchmarkTag':
            const tagComp = new BenchmarkTag();
            tagComp.name = def.properties[0].generator();
            tagComp.color = def.properties[1].generator();
            tagComp.usage_count = def.properties[2].generator();
            tagComp.created_by = def.properties[3].generator();
            return tagComp;

        case 'BenchmarkComment':
            const commentComp = new BenchmarkComment();
            commentComp.entity_id = def.properties[0].generator();
            commentComp.user_id = def.properties[1].generator();
            commentComp.content = def.properties[2].generator();
            commentComp.parent_id = def.properties[3].generator();
            commentComp.created_at = def.properties[4].generator();
            commentComp.moderated = def.properties[5].generator();
            return commentComp;

        case 'BenchmarkVote':
            const voteComp = new BenchmarkVote();
            voteComp.user_id = def.properties[0].generator();
            voteComp.entity_id = def.properties[1].generator();
            voteComp.entity_type = def.properties[2].generator();
            voteComp.vote_type = def.properties[3].generator();
            voteComp.voted_at = def.properties[4].generator();
            return voteComp;

        case 'BenchmarkReport':
            const reportComp = new BenchmarkReport();
            reportComp.reporter_id = def.properties[0].generator();
            reportComp.entity_id = def.properties[1].generator();
            reportComp.reason = def.properties[2].generator();
            reportComp.description = def.properties[3].generator();
            reportComp.status = def.properties[4].generator();
            reportComp.created_at = def.properties[5].generator();
            return reportComp;

        case 'BenchmarkBackup':
            const backupComp = new BenchmarkBackup();
            backupComp.user_id = def.properties[0].generator();
            backupComp.backup_id = def.properties[1].generator();
            backupComp.size = def.properties[2].generator();
            backupComp.created_at = def.properties[3].generator();
            backupComp.expires_at = def.properties[4].generator();
            backupComp.status = def.properties[5].generator();
            return backupComp;

        case 'BenchmarkIntegration':
            const integrationComp = new BenchmarkIntegration();
            integrationComp.user_id = def.properties[0].generator();
            integrationComp.provider = def.properties[1].generator();
            integrationComp.external_id = def.properties[2].generator();
            integrationComp.access_token = def.properties[3].generator();
            integrationComp.refresh_token = def.properties[4].generator();
            integrationComp.expires_at = def.properties[5].generator();
            return integrationComp;

        case 'BenchmarkSchedule':
            const scheduleComp = new BenchmarkSchedule();
            scheduleComp.user_id = def.properties[0].generator();
            scheduleComp.title = def.properties[1].generator();
            scheduleComp.description = def.properties[2].generator();
            scheduleComp.start_time = def.properties[3].generator();
            scheduleComp.end_time = def.properties[4].generator();
            scheduleComp.recurring = def.properties[5].generator();
            return scheduleComp;

        case 'BenchmarkTask':
            const taskComp = new BenchmarkTask();
            taskComp.user_id = def.properties[0].generator();
            taskComp.title = def.properties[1].generator();
            taskComp.description = def.properties[2].generator();
            taskComp.priority = def.properties[3].generator();
            taskComp.due_date = def.properties[4].generator();
            taskComp.completed = def.properties[5].generator();
            return taskComp;

        case 'BenchmarkProject':
            const projectComp = new BenchmarkProject();
            projectComp.name = def.properties[0].generator();
            projectComp.owner_id = def.properties[1].generator();
            projectComp.description = def.properties[2].generator();
            projectComp.status = def.properties[3].generator();
            projectComp.created_at = def.properties[4].generator();
            projectComp.deadline = def.properties[5].generator();
            return projectComp;

        case 'BenchmarkTeam':
            const teamComp = new BenchmarkTeam();
            teamComp.name = def.properties[0].generator();
            teamComp.owner_id = def.properties[1].generator();
            teamComp.members = def.properties[2].generator();
            teamComp.created_at = def.properties[3].generator();
            teamComp.is_active = def.properties[4].generator();
            return teamComp;

        case 'BenchmarkRole':
            const roleComp = new BenchmarkRole();
            roleComp.name = def.properties[0].generator();
            roleComp.permissions = def.properties[1].generator();
            roleComp.level = def.properties[2].generator();
            roleComp.description = def.properties[3].generator();
            return roleComp;

        case 'BenchmarkApiKey':
            const apiKeyComp = new BenchmarkApiKey();
            apiKeyComp.user_id = def.properties[0].generator();
            apiKeyComp.name = def.properties[1].generator();
            apiKeyComp.key = def.properties[2].generator();
            apiKeyComp.permissions = def.properties[3].generator();
            apiKeyComp.expires_at = def.properties[4].generator();
            apiKeyComp.last_used = def.properties[5].generator();
            return apiKeyComp;

        case 'BenchmarkWebhook':
            const webhookComp = new BenchmarkWebhook();
            webhookComp.user_id = def.properties[0].generator();
            webhookComp.url = def.properties[1].generator();
            webhookComp.events = def.properties[2].generator();
            webhookComp.secret = def.properties[3].generator();
            webhookComp.is_active = def.properties[4].generator();
            return webhookComp;

        case 'BenchmarkTemplate':
            const templateComp = new BenchmarkTemplate();
            templateComp.name = def.properties[0].generator();
            templateComp.type = def.properties[1].generator();
            templateComp.content = def.properties[2].generator();
            templateComp.variables = def.properties[3].generator();
            templateComp.created_by = def.properties[4].generator();
            return templateComp;

        case 'BenchmarkWorkflow':
            const workflowComp = new BenchmarkWorkflow();
            workflowComp.name = def.properties[0].generator();
            workflowComp.steps = def.properties[1].generator();
            workflowComp.triggers = def.properties[2].generator();
            workflowComp.is_active = def.properties[3].generator();
            workflowComp.created_by = def.properties[4].generator();
            return workflowComp;

        case 'BenchmarkAlert':
            const alertComp = new BenchmarkAlert();
            alertComp.user_id = def.properties[0].generator();
            alertComp.type = def.properties[1].generator();
            alertComp.condition = def.properties[2].generator();
            alertComp.threshold = def.properties[3].generator();
            alertComp.is_active = def.properties[4].generator();
            return alertComp;

        case 'BenchmarkMetric':
            const metricComp = new BenchmarkMetric();
            metricComp.name = def.properties[0].generator();
            metricComp.value = def.properties[1].generator();
            metricComp.unit = def.properties[2].generator();
            metricComp.timestamp = def.properties[3].generator();
            metricComp.source = def.properties[4].generator();
            return metricComp;

        case 'BenchmarkQuota':
            const quotaComp = new BenchmarkQuota();
            quotaComp.user_id = def.properties[0].generator();
            quotaComp.resource = def.properties[1].generator();
            quotaComp.limit = def.properties[2].generator();
            quotaComp.used = def.properties[3].generator();
            quotaComp.reset_date = def.properties[4].generator();
            return quotaComp;

        // Handle Comp1-Comp25 components
        case 'Comp1':
            const comp1 = new Comp1();
            comp1.entity_id = def.properties[0].generator();
            comp1.value1 = def.properties[1].generator();
            comp1.value2 = def.properties[2].generator();
            comp1.value3 = def.properties[3].generator();
            comp1.timestamp = def.properties[4].generator();
            return comp1;

        case 'Comp2':
            const comp2 = new Comp2();
            comp2.entity_id = def.properties[0].generator();
            comp2.value1 = def.properties[1].generator();
            comp2.value2 = def.properties[2].generator();
            comp2.value3 = def.properties[3].generator();
            comp2.timestamp = def.properties[4].generator();
            return comp2;

        case 'Comp3':
            const comp3 = new Comp3();
            comp3.entity_id = def.properties[0].generator();
            comp3.value1 = def.properties[1].generator();
            comp3.value2 = def.properties[2].generator();
            comp3.value3 = def.properties[3].generator();
            comp3.timestamp = def.properties[4].generator();
            return comp3;

        case 'Comp4':
            const comp4 = new Comp4();
            comp4.entity_id = def.properties[0].generator();
            comp4.value1 = def.properties[1].generator();
            comp4.value2 = def.properties[2].generator();
            comp4.value3 = def.properties[3].generator();
            comp4.timestamp = def.properties[4].generator();
            return comp4;

        case 'Comp5':
            const comp5 = new Comp5();
            comp5.entity_id = def.properties[0].generator();
            comp5.value1 = def.properties[1].generator();
            comp5.value2 = def.properties[2].generator();
            comp5.value3 = def.properties[3].generator();
            comp5.timestamp = def.properties[4].generator();
            return comp5;

        case 'Comp6':
            const comp6 = new Comp6();
            comp6.entity_id = def.properties[0].generator();
            comp6.value1 = def.properties[1].generator();
            comp6.value2 = def.properties[2].generator();
            comp6.value3 = def.properties[3].generator();
            comp6.timestamp = def.properties[4].generator();
            return comp6;

        case 'Comp7':
            const comp7 = new Comp7();
            comp7.entity_id = def.properties[0].generator();
            comp7.value1 = def.properties[1].generator();
            comp7.value2 = def.properties[2].generator();
            comp7.value3 = def.properties[3].generator();
            comp7.timestamp = def.properties[4].generator();
            return comp7;

        case 'Comp8':
            const comp8 = new Comp8();
            comp8.entity_id = def.properties[0].generator();
            comp8.value1 = def.properties[1].generator();
            comp8.value2 = def.properties[2].generator();
            comp8.value3 = def.properties[3].generator();
            comp8.timestamp = def.properties[4].generator();
            return comp8;

        case 'Comp9':
            const comp9 = new Comp9();
            comp9.entity_id = def.properties[0].generator();
            comp9.value1 = def.properties[1].generator();
            comp9.value2 = def.properties[2].generator();
            comp9.value3 = def.properties[3].generator();
            comp9.timestamp = def.properties[4].generator();
            return comp9;

        case 'Comp10':
            const comp10 = new Comp10();
            comp10.entity_id = def.properties[0].generator();
            comp10.value1 = def.properties[1].generator();
            comp10.value2 = def.properties[2].generator();
            comp10.value3 = def.properties[3].generator();
            comp10.timestamp = def.properties[4].generator();
            return comp10;

        case 'Comp11':
            const comp11 = new Comp11();
            comp11.entity_id = def.properties[0].generator();
            comp11.value1 = def.properties[1].generator();
            comp11.value2 = def.properties[2].generator();
            comp11.value3 = def.properties[3].generator();
            comp11.timestamp = def.properties[4].generator();
            return comp11;

        case 'Comp12':
            const comp12 = new Comp12();
            comp12.entity_id = def.properties[0].generator();
            comp12.value1 = def.properties[1].generator();
            comp12.value2 = def.properties[2].generator();
            comp12.value3 = def.properties[3].generator();
            comp12.timestamp = def.properties[4].generator();
            return comp12;

        case 'Comp13':
            const comp13 = new Comp13();
            comp13.entity_id = def.properties[0].generator();
            comp13.value1 = def.properties[1].generator();
            comp13.value2 = def.properties[2].generator();
            comp13.value3 = def.properties[3].generator();
            comp13.timestamp = def.properties[4].generator();
            return comp13;

        case 'Comp14':
            const comp14 = new Comp14();
            comp14.entity_id = def.properties[0].generator();
            comp14.value1 = def.properties[1].generator();
            comp14.value2 = def.properties[2].generator();
            comp14.value3 = def.properties[3].generator();
            comp14.timestamp = def.properties[4].generator();
            return comp14;

        case 'Comp15':
            const comp15 = new Comp15();
            comp15.entity_id = def.properties[0].generator();
            comp15.value1 = def.properties[1].generator();
            comp15.value2 = def.properties[2].generator();
            comp15.value3 = def.properties[3].generator();
            comp15.timestamp = def.properties[4].generator();
            return comp15;

        case 'Comp16':
            const comp16 = new Comp16();
            comp16.entity_id = def.properties[0].generator();
            comp16.value1 = def.properties[1].generator();
            comp16.value2 = def.properties[2].generator();
            comp16.value3 = def.properties[3].generator();
            comp16.timestamp = def.properties[4].generator();
            return comp16;

        case 'Comp17':
            const comp17 = new Comp17();
            comp17.entity_id = def.properties[0].generator();
            comp17.value1 = def.properties[1].generator();
            comp17.value2 = def.properties[2].generator();
            comp17.value3 = def.properties[3].generator();
            comp17.timestamp = def.properties[4].generator();
            return comp17;

        case 'Comp18':
            const comp18 = new Comp18();
            comp18.entity_id = def.properties[0].generator();
            comp18.value1 = def.properties[1].generator();
            comp18.value2 = def.properties[2].generator();
            comp18.value3 = def.properties[3].generator();
            comp18.timestamp = def.properties[4].generator();
            return comp18;

        case 'Comp19':
            const comp19 = new Comp19();
            comp19.entity_id = def.properties[0].generator();
            comp19.value1 = def.properties[1].generator();
            comp19.value2 = def.properties[2].generator();
            comp19.value3 = def.properties[3].generator();
            comp19.timestamp = def.properties[4].generator();
            return comp19;

        case 'Comp20':
            const comp20 = new Comp20();
            comp20.entity_id = def.properties[0].generator();
            comp20.value1 = def.properties[1].generator();
            comp20.value2 = def.properties[2].generator();
            comp20.value3 = def.properties[3].generator();
            comp20.timestamp = def.properties[4].generator();
            return comp20;

        case 'Comp21':
            const comp21 = new Comp21();
            comp21.entity_id = def.properties[0].generator();
            comp21.value1 = def.properties[1].generator();
            comp21.value2 = def.properties[2].generator();
            comp21.value3 = def.properties[3].generator();
            comp21.timestamp = def.properties[4].generator();
            return comp21;

        case 'Comp22':
            const comp22 = new Comp22();
            comp22.entity_id = def.properties[0].generator();
            comp22.value1 = def.properties[1].generator();
            comp22.value2 = def.properties[2].generator();
            comp22.value3 = def.properties[3].generator();
            comp22.timestamp = def.properties[4].generator();
            return comp22;

        case 'Comp23':
            const comp23 = new Comp23();
            comp23.entity_id = def.properties[0].generator();
            comp23.value1 = def.properties[1].generator();
            comp23.value2 = def.properties[2].generator();
            comp23.value3 = def.properties[3].generator();
            comp23.timestamp = def.properties[4].generator();
            return comp23;

        case 'Comp24':
            const comp24 = new Comp24();
            comp24.entity_id = def.properties[0].generator();
            comp24.value1 = def.properties[1].generator();
            comp24.value2 = def.properties[2].generator();
            comp24.value3 = def.properties[3].generator();
            comp24.timestamp = def.properties[4].generator();
            return comp24;

        case 'Comp25':
            const comp25 = new Comp25();
            comp25.entity_id = def.properties[0].generator();
            comp25.value1 = def.properties[1].generator();
            comp25.value2 = def.properties[2].generator();
            comp25.value3 = def.properties[3].generator();
            comp25.timestamp = def.properties[4].generator();
            return comp25;

        default:
            // Try to use generated components (Comp26-Comp100)
            const GeneratedCtor = generatedComponentMap.get(def.name);
            if (GeneratedCtor) {
                const generatedComp = new GeneratedCtor();
                // Use the data generator from generated-components if available
                const dataGenerator = componentDataGenerators.get(def.name);
                if (dataGenerator) {
                    const data = dataGenerator(entityId);
                    Object.assign(generatedComp, data);
                } else {
                    // Fallback to def.properties
                    for (let i = 0; i < def.properties.length; i++) {
                        const prop = def.properties[i];
                        (generatedComp as any)[prop.name] = prop.generator();
                    }
                }
                return generatedComp;
            }
            throw new Error(`Unknown component type: ${def.name}`);
    }
}

// Benchmark scenarios - using generated Comp1-Comp100 components for accurate testing
export const BENCHMARK_SCENARIOS = {
    singleComponentFilter: {
        name: 'Single Component Filter',
        description: 'Query with single component (no filter to ensure data exists)',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1);
        }
    },

    multiComponentAnd: {
        name: 'Multi Component AND',
        description: 'Query with multiple components using AND logic',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1)
                .with(Comp2);
        }
    },

    orQuery: {
        name: 'OR Query',
        description: 'Query with OR logic across multiple components',
        setup: async (): Promise<Query> => {
            const orQuery = or([
                {
                    component: Comp1
                },
                {
                    component: Comp2
                }
            ]);
            return new Query().with(orQuery);
        }
    },

    sortQuery: {
        name: 'Sort Query',
        description: 'Query with component data sorting',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1)
                .sortBy(Comp1, 'name_1', 'ASC')
                .take(10);
        }
    },

    populateSingleType: {
        name: 'Populate Single Type',
        description: 'Query with populate for single component type',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1)
                .take(5);
        },
        populate: true
    },

    populateMultiType: {
        name: 'Populate Multi Type',
        description: 'Query with populate for multiple component types',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1)
                .with(Comp2)
                .take(5);
        },
        populate: true
    },

    countQuery: {
        name: 'Count Query',
        description: 'Count query with filters',
        setup: async (): Promise<Query> => {
            return new Query()
                .with(Comp1);
        },
        isCount: true
    }
};

/**
 * Parse EXPLAIN ANALYZE output to extract timing and buffer information
 */
export function parseExplainAnalyze(explainOutput: string): {
    planningTime: number;
    executionTime: number;
    totalTime: number;
    bufferHits: number;
    bufferReads: number;
    bufferHitRatio: number;
} {
    const planningMatch = explainOutput.match(/Planning time:\s*([\d.]+)ms/);
    const executionMatch = explainOutput.match(/Execution time:\s*([\d.]+)ms/);
    const bufferMatch = explainOutput.match(/Buffers:\s*shared\s*hit=(\d+)\s*read=(\d+)/);

    const planningTime = planningMatch ? parseFloat(planningMatch[1]) : 0;
    const executionTime = executionMatch ? parseFloat(executionMatch[1]) : 0;
    const totalTime = planningTime + executionTime;

    let bufferHits = 0;
    let bufferReads = 0;
    let bufferHitRatio = 100;

    if (bufferMatch) {
        bufferHits = parseInt(bufferMatch[1]);
        bufferReads = parseInt(bufferMatch[2]);
        const totalBuffers = bufferHits + bufferReads;
        bufferHitRatio = totalBuffers > 0 ? (bufferHits / totalBuffers) * 100 : 100;
    }

    return {
        planningTime,
        executionTime,
        totalTime,
        bufferHits,
        bufferReads,
        bufferHitRatio
    };
}

/**
 * Run a single benchmark scenario
 */
export async function runBenchmarkScenario(
    scenarioName: string,
    query: Query,
    strategy: 'list' | 'hash',
    useDirectPartition: boolean,
    options: {
        isCount?: boolean;
        populate?: boolean;
        debug?: boolean;
    } = {}
): Promise<BenchmarkResult> {
    const { isCount = false, populate = false, debug = false } = options;

    let result: any[] | number;
    let explainOutput: string | null = null;
    let rowsReturned = 0;

    if (isCount) {
        // For count queries, measure execution time
        const startTime = performance.now();
        result = await query.count();
        const endTime = performance.now();
        rowsReturned = typeof result === 'number' ? result : 0;

        return {
            strategy: strategy,
            useDirectPartition: useDirectPartition,
            queryType: scenarioName,
            planningTimeMs: 0, // Count doesn't provide planning time
            executionTimeMs: endTime - startTime,
            totalTimeMs: endTime - startTime,
            rowsReturned,
            bufferHits: 0,
            bufferReads: 0,
            bufferHitRatio: 100,
            timestamp: new Date()
        };
    } else {
        // For regular queries, use EXPLAIN ANALYZE
        try {
            const explainQuery = query.debugMode(debug);
            explainOutput = await explainQuery.explainAnalyze(true);
        } catch (explainError) {
            console.error('EXPLAIN ANALYZE failed:', explainError);
            throw explainError;
        }

        const startTime = performance.now();
        try {
            result = await query.exec();
        } catch (error) {
            console.error(`Query execution failed:`, error);
            // Try to get the SQL that was generated
            const debugQuery = query.debugMode(true);
            try {
                const explainResult = await debugQuery.explainAnalyze(true);
                console.error(`Generated SQL:`, explainResult.split('\n')[0]);
            } catch (explainError) {
                console.error(`Could not get explain:`, explainError);
            }
            throw error;
        }
        const endTime = performance.now();

        rowsReturned = Array.isArray(result) ? result.length : 0;

        const explainData = parseExplainAnalyze(explainOutput);

        return {
            strategy: strategy,
            useDirectPartition: useDirectPartition,
            queryType: scenarioName,
            planningTimeMs: explainData.planningTime,
            executionTimeMs: explainData.executionTime,
            totalTimeMs: explainData.totalTime + (endTime - startTime),
            rowsReturned,
            bufferHits: explainData.bufferHits,
            bufferReads: explainData.bufferReads,
            bufferHitRatio: explainData.bufferHitRatio,
            timestamp: new Date()
        };
    }
}

/**
 * Setup test environment with specific partition strategy
 */
export async function setupBenchmarkEnvironment(
    strategy: 'list' | 'hash',
    useDirectPartition: boolean = false
): Promise<void> {
    // Set environment variables
    process.env.BUNSANE_PARTITION_STRATEGY = strategy;
    process.env.BUNSANE_USE_DIRECT_PARTITION = useDirectPartition ? 'true' : 'false';

    // Reload config to pick up the new environment variables
    config.reloadConfig();
    console.log(`Config reloaded: useDirectPartition=${config.shouldUseDirectPartition()}, strategy=${config.getPartitionStrategy()}`);

    // Reinitialize database with new strategy
    console.log(`Setting up database with ${strategy} partitioning${useDirectPartition ? ' + direct partition access' : ''}...`);
    await PrepareDatabase();

    // Ensure components are registered
    await ComponentRegistry.ensureComponentsRegistered();

    // Explicitly register all benchmark components to ensure they exist
    const benchmarkComponents = [];

    // Add available components Comp1-Comp25 (we've defined these so far)
    for (let i = 1; i <= 25; i++) {
        benchmarkComponents.push(`Comp${i}`);
    }

    for (const componentName of benchmarkComponents) {
        try {
            // Try to get the component ID - this will register it if not already registered
            const componentId = ComponentRegistry.getComponentId(componentName);
            if (!componentId) {
                console.log(`Warning: Could not register component ${componentName}`);
            }
        } catch (error) {
            console.log(`Warning: Error registering component ${componentName}: ${error}`);
        }
    }

    // Verify that our benchmark components are registered
    const comp1Id = ComponentRegistry.getComponentId('Comp1');
    const comp50Id = ComponentRegistry.getComponentId('Comp50');
    const comp100Id = ComponentRegistry.getComponentId('Comp100');

    console.log(`Component registration check:`);
    console.log(`  Comp1: ${comp1Id ? '✓' : '✗'} (${comp1Id})`);
    console.log(`  Comp50: ${comp50Id ? '✓' : '✗'} (${comp50Id})`);
    console.log(`  Comp100: ${comp100Id ? '✓' : '✗'} (${comp100Id})`);

    if (!comp1Id || !comp50Id || !comp100Id) {
        throw new Error('Failed to register benchmark components');
    }

    console.log('Database setup complete');
}

/**
 * Generate sample benchmark data
 */
export async function generateBenchmarkData(entityCount: number = 1000, componentCount: number = 5): Promise<void> {
    console.log(`Generating ${entityCount} entities with ${componentCount} component types for benchmark testing...`);

    // Generate component definitions
    const componentDefinitions = generateComponentDefinitions(componentCount);

    // Generate entities
    const entities: Entity[] = [];
    for (let i = 0; i < entityCount; i++) {
        const entity = new Entity();
        entities.push(entity);
    }

    // Attach components to entities based on definitions
    for (const entity of entities) {
        for (const def of componentDefinitions) {
            // Check if this component should be attached based on frequency
            if (Math.random() < def.frequency) {
                // Create a dynamic component instance
                const componentInstance = createComponentInstance(def, entity.id);
                entity.addComponent(componentInstance);
            }
        }

        // Save entity
        await entity.save();
    }

    // Analyze tables for query optimization
    await db.unsafe('ANALYZE components');
    await db.unsafe('ANALYZE entity_components');

    const availableComponents = componentDefinitions.length;
    console.log(`Generated ${entityCount} entities with up to ${Math.min(componentCount, availableComponents)} component types (${availableComponents} available)`);
    console.log(`Component types used: ${componentDefinitions.slice(0, Math.min(componentCount, availableComponents)).map(d => d.name).join(', ')}`);
}

/**
 * Run complete benchmark suite
 */
export async function runBenchmarkSuite(
    strategy: 'list' | 'hash',
    useDirectPartition: boolean,
    entityCount: number = 1000,
    componentCount: number = 5
): Promise<BenchmarkResult[]> {
    console.log(`\n=== Running Benchmark Suite ===`);
    console.log(`Strategy: ${strategy}${useDirectPartition ? ' + Direct Partition' : ''}`);
    console.log(`Entities: ${entityCount}, Components: ${componentCount}`);

    // Setup environment
    await setupBenchmarkEnvironment(strategy, useDirectPartition);

    // Generate test data
    await generateBenchmarkData(entityCount, componentCount);

    const results: BenchmarkResult[] = [];

    // Run each scenario
    for (const [scenarioKey, scenarioConfig] of Object.entries(BENCHMARK_SCENARIOS)) {
        console.log(`\nRunning scenario: ${scenarioConfig.name}`);

        try {
            const query = await scenarioConfig.setup();

            const result = await runBenchmarkScenario(
                scenarioConfig.name,
                query,
                strategy,
                useDirectPartition,
                {
                    isCount: scenarioConfig.isCount,
                    populate: scenarioConfig.populate
                }
            );

            results.push(result);

            console.log(`  ✓ ${scenarioConfig.name}: ${result.totalTimeMs.toFixed(2)}ms (${result.rowsReturned} rows)`);

        } catch (error) {
            console.error(`  ✗ ${scenarioConfig.name} failed:`, error);
        }
    }

    return results;
}

/**
 * Format benchmark results as ASCII table
 */
export function formatBenchmarkResults(results: BenchmarkResult[]): string {
    const lines: string[] = [];

    lines.push('┌─────────────────────────────────────────────────────────────────────────────────────┐');
    lines.push('│ Partition Strategy Benchmark Results                                              │');
    lines.push('├────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────┤');
    lines.push('│ Query Type         │ Strategy │ Direct   │ Planning │ Execution│ Total    │ Rows  │');
    lines.push('├────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────┤');

    const groupedResults = new Map<string, BenchmarkResult[]>();
    for (const result of results) {
        const key = result.queryType;
        if (!groupedResults.has(key)) {
            groupedResults.set(key, []);
        }
        groupedResults.get(key)!.push(result);
    }

    for (const [queryType, queryResults] of groupedResults) {
        // Sort by strategy and direct partition
        queryResults.sort((a, b) => {
            if (a.strategy !== b.strategy) {
                return a.strategy.localeCompare(b.strategy);
            }
            return Number(a.useDirectPartition) - Number(b.useDirectPartition);
        });

        for (const result of queryResults) {
            const strategy = result.strategy.toUpperCase();
            const direct = result.useDirectPartition ? 'YES' : 'NO';
            const planning = result.planningTimeMs.toFixed(1);
            const execution = result.executionTimeMs.toFixed(1);
            const total = result.totalTimeMs.toFixed(1);
            const rows = result.rowsReturned.toString();

            lines.push(`│ ${queryType.padEnd(18)} │ ${strategy.padEnd(8)} │ ${direct.padEnd(8)} │ ${planning.padStart(8)} │ ${execution.padStart(8)} │ ${total.padStart(8)} │ ${rows.padStart(5)} │`);
        }
    }

    lines.push('└────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────┘');

    return lines.join('\n');
}
