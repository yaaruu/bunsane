/**
 * Example: Query Populate Functionality
 * 
 * This example demonstrates how to use the .populate() method
 * to pre-fill entity objects with components, improving performance
 * by reducing database queries.
 */

import { Query } from '../query/Query';
import { Entity } from '../core/Entity';
import { Component, CompData, BaseComponent } from '../core/Components';

// Define example components
@Component
class UserName extends BaseComponent {
    @CompData()
    firstName!: string;

    @CompData()
    lastName!: string;
}

@Component
class UserEmail extends BaseComponent {
    @CompData()
    email!: string;
}

@Component
class UserProfile extends BaseComponent {
    @CompData()
    bio!: string;

    @CompData()
    joinDate!: Date;
}

// Example 1: Without populate (multiple DB queries)
async function exampleWithoutPopulate() {
    console.log('\n📦 Example 1: Without populate');
    console.log('─'.repeat(50));
    
    const users = await new Query()
        .with(UserName)
        .with(UserEmail)
        .take(10)
        .exec();

    console.log(`Found ${users.length} users`);

    // Each get() call triggers a separate database query
    for (const user of users) {
        const name = await user.get(UserName);     // DB query #1
        const email = await user.get(UserEmail);   // DB query #2
        
        console.log(`- ${name?.firstName} ${name?.lastName} <${email?.email}>`);
    }
    
    console.log('⚠️  Total DB queries: 1 (query) + 2N (component fetches)');
}

// Example 2: With populate (optimized bulk query)
async function exampleWithPopulate() {
    console.log('\n⚡ Example 2: With populate');
    console.log('─'.repeat(50));
    
    const users = await new Query()
        .with(UserName)
        .with(UserEmail)
        .populate()  // 👈 Enable populate
        .take(10)
        .exec();

    console.log(`Found ${users.length} users`);

    // Components are already loaded - no additional DB queries!
    for (const user of users) {
        const name = await user.get(UserName);     // Instant - already in memory
        const email = await user.get(UserEmail);   // Instant - already in memory
        
        console.log(`- ${name?.firstName} ${name?.lastName} <${email?.email}>`);
    }
    
    console.log('✅ Total DB queries: 2 (query + bulk component fetch)');
}

// Example 3: Selective populate
async function exampleSelectivePopulate() {
    console.log('\n🎯 Example 3: Selective populate');
    console.log('─'.repeat(50));
    
    const users = await new Query()
        .with(UserName)
        .with(UserEmail)
        .populate()  // Only populates UserName and UserEmail
        .take(5)
        .exec();

    console.log(`Found ${users.length} users`);

    for (const user of users) {
        // Pre-populated - instant access
        const name = await user.get(UserName);
        const email = await user.get(UserEmail);
        
        // Not in query - triggers DB query on first access
        const profile = await user.get(UserProfile);
        
        console.log(`- ${name?.firstName} ${name?.lastName}`);
        console.log(`  Email: ${email?.email}`);
        console.log(`  Bio: ${profile?.bio || 'N/A'}`);
    }
    
    console.log('📝 UserName and UserEmail pre-loaded, UserProfile fetched on demand');
}

// Example 4: With filters and populate
async function exampleFiltersWithPopulate() {
    console.log('\n🔍 Example 4: Filters with populate');
    console.log('─'.repeat(50));
    
    const users = await new Query()
        .with(UserName, Query.filters(
            Query.filter('firstName', Query.filterOp.LIKE, 'John%')
        ))
        .with(UserEmail)
        .populate()
        .exec();

    console.log(`Found ${users.length} users with firstName starting with 'John'`);

    for (const user of users) {
        const name = await user.get(UserName);
        const email = await user.get(UserEmail);
        
        console.log(`- ${name?.firstName} ${name?.lastName} <${email?.email}>`);
    }
}

// Performance comparison
async function performanceComparison() {
    console.log('\n⏱️  Performance Comparison');
    console.log('─'.repeat(50));
    
    // Without populate
    const startWithout = performance.now();
    const users1 = await new Query()
        .with(UserName)
        .with(UserEmail)
        .take(100)
        .exec();
    
    for (const user of users1) {
        await user.get(UserName);
        await user.get(UserEmail);
    }
    const timeWithout = performance.now() - startWithout;
    
    // With populate
    const startWith = performance.now();
    const users2 = await new Query()
        .with(UserName)
        .with(UserEmail)
        .populate()
        .take(100)
        .exec();
    
    for (const user of users2) {
        await user.get(UserName);
        await user.get(UserEmail);
    }
    const timeWith = performance.now() - startWith;
    
    console.log(`Without populate: ${timeWithout.toFixed(2)}ms (${201} DB queries)`);
    console.log(`With populate:    ${timeWith.toFixed(2)}ms (2 DB queries)`);
    console.log(`Speedup:          ${(timeWithout / timeWith).toFixed(2)}x faster`);
}

// Best Practices Guide
function printBestPractices() {
    console.log('\n📚 Best Practices for .populate()');
    console.log('─'.repeat(50));
    console.log(`
✅ USE populate() when:
   - You know you'll access component data for all/most entities
   - Querying many entities and need their components
   - Building API responses that include component data
   - Performance is critical and you want to minimize DB queries

❌ DON'T USE populate() when:
   - Only querying entity IDs without component access
   - Conditionally accessing components (e.g., if statements)
   - Working with very large result sets where memory is a concern
   - You only need components for a few entities out of many

💡 TIPS:
   - populate() only loads components specified in .with()
   - Combine with .take() and .offset() for pagination
   - Use with filters to reduce data volume
   - Monitor performance with .debugMode(true)
    `);
}

// Run examples
async function main() {
    console.log('\n🚀 Query Populate Functionality Examples');
    console.log('═'.repeat(50));
    
    try {
        await exampleWithoutPopulate();
        await exampleWithPopulate();
        await exampleSelectivePopulate();
        await exampleFiltersWithPopulate();
        await performanceComparison();
        printBestPractices();
        
        console.log('\n✅ All examples completed successfully!');
    } catch (error) {
        console.error('❌ Error running examples:', error);
    }
}

// Uncomment to run examples
// main();

export {
    exampleWithoutPopulate,
    exampleWithPopulate,
    exampleSelectivePopulate,
    exampleFiltersWithPopulate,
    performanceComparison
};
