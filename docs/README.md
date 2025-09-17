# BunSane Framework Documentation

Welcome to the official documentation for **BunSane** - a batteries-included TypeScript API framework built on the Bun runtime.

## 🎯 What Makes BunSane Special?

BunSane revolutionizes API development by combining the power of Entity-Component-System (ECS) architecture with modern TypeScript. Built specifically for Bun's high-performance runtime, it provides a flexible foundation for building scalable applications.

### Key Differentiators

- **ECS Architecture**: Flexible data modeling without traditional ORM limitations
- **Type-Safe Everything**: Full TypeScript integration with compile-time guarantees
- **Bun-Native Performance**: Optimized for Bun's speed and efficiency
- **Component-Based Design**: Build complex entities from reusable components
- **Built-in GraphQL Support**: GraphQL integration with Yoga

## 🚀 Quick Start

Get up and running in minutes:

```bash
# Install BunSane
bun install bunsane

# Create your first entity
import { Entity, Component, CompData, BaseComponent } from 'bunsane';

@Component
class UserProfile extends BaseComponent {
  @CompData()
  name: string = '';

  @CompData()
  email: string = '';
}

// Create and save an entity
const user = Entity.Create();
user.add(UserProfile, { name: 'John Doe', email: 'john@example.com' });
await user.save();
```

## 📚 Core Architecture

BunSane is built around four fundamental concepts:

### 1. **Entities** - Your Data Objects
Entities are the core data containers in BunSane. Unlike traditional objects, entities are composed of multiple components, allowing for flexible and dynamic data structures.

### 2. **Components** - Data Building Blocks
Components are pure data structures that define specific aspects of your entities. They're decorated with `@CompData()` and automatically persisted to PostgreSQL.

### 3. **ArcheTypes** - Entity Templates
ArcheTypes provide reusable templates for creating entities with predefined component sets, reducing code duplication and ensuring consistency.

### 4. **Services** - Business Logic
Services contain your business logic and can integrate with GraphQL resolvers for API endpoints.

## 🔧 Features

- **Lifecycle Hooks**: React to entity creation, updates, and deletion
- **Query System**: Type-safe querying with filtering
- **Component Registry**: Automatic component discovery and registration
- **Entity Caching**: Built-in caching for improved performance
- **GraphQL Integration**: Basic GraphQL support with Yoga
- **File Upload Support**: Basic file upload handling
- **Background Tasks**: Simple scheduled task support
- **Request Context**: Context management for requests

## 📖 Documentation Sections

### Getting Started
- **[Installation Guide](getting-started.md)** - Setup and configuration
- **[Interactive Demo](examples/interactive-demo.md)** - Live code examples
- **[Code Examples](examples/code-examples.md)** - Complete runnable examples

### Core Concepts
- **[Entities](core-concepts/entity.md)** - Entity lifecycle and management
- **[Components](core-concepts/components.md)** - Component definitions and patterns
- **[ArcheTypes](core-concepts/archetypes.md)** - Entity templates and reuse
- **[Services](core-concepts/services.md)** - Business logic layer
- **[Query System](core-concepts/query.md)** - Database querying
- **[Hooks](core-concepts/hooks.md)** - Lifecycle events and customization

### Advanced Features
- **[File Uploads](advanced/uploads.md)** - File handling and storage
- **[Background Tasks](advanced/scheduler.md)** - Job scheduling and processing
- **[Performance](advanced/performance.md)** - Optimization strategies
- **[Security](advanced/security.md)** - Authentication and authorization

### API Reference
- **[Core API](api/core.md)** - Entity, Component, ArcheType classes
- **[Query API](api/query.md)** - Database operations and querying
- **[Service API](api/service.md)** - Business logic services
- **[Hooks API](api/hooks.md)** - Event system and lifecycle
- **[Upload API](api/upload.md)** - File management
- **[Scheduler API](api/scheduler.md)** - Background job management
- **[Performance Guide](api/performance.md)** - Optimization techniques
- **[Testing Guide](api/testing.md)** - Testing patterns and best practices

## 🌟 Real-World Use Cases

BunSane excels in applications requiring:

- **Content Management Systems** - Flexible content modeling with components
- **E-commerce Platforms** - Complex product catalogs with dynamic attributes
- **Business Applications** - Multi-tenant architectures with customizable entities
- **Data-Intensive Applications** - Structured data with relationships

## 🤝 Community & Support

- **GitHub**: [yaaruu/bunsane](https://github.com/yaaruu/bunsane)
- **Issues**: [Report bugs or request features](https://github.com/yaaruu/bunsane/issues)
- **Discussions**: [Community discussions](https://github.com/yaaruu/bunsane/discussions)

## 📈 Project Status

**Current Version**: 0.1.0 (Development)
**Documentation**: ✅ Complete API Reference
**Status**: Actively developed
**License**: MIT

### ✅ Implemented Features
- **Core ECS Architecture**: Entity, Component, ArcheType system
- **Database Integration**: PostgreSQL with automatic schema management
- **Query System**: Type-safe database querying
- **Hook System**: Entity and component lifecycle events
- **Service Layer**: Business logic organization
- **Basic GraphQL**: GraphQL integration with static schema
- **File Upload**: Basic file upload handling
- **Background Tasks**: Simple task scheduling
- **Component Registry**: Automatic component discovery

### 🚧 In Development
- **Advanced GraphQL**: Dynamic schema generation from services
- **Full-Text Search**: Search capabilities across entities
- **Real-time Features**: WebSocket support for live updates
- **Advanced Caching**: Distributed caching strategies
- **OpenAPI Integration**: Automatic API documentation

### 📋 Planned Features
- **Custom Component Tables**: Direct column storage instead of JSONB
- **Filesystem Integration**: Advanced file management
- **Field Constraints**: Data validation and constraints
- **OpenAPI Specification**: Automatic API spec generation

---

*Ready to build something amazing? Let's get started!* 🚀