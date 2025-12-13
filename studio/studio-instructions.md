---
applyTo: '**'
---

# Bunsane studio

## About the project

the project is to create PostgreSQL database management
with support for ECS (Entity Component System) model

there are some tables that we need to pay attention, i.e:
- components (ECS table)
- entities (ECS table)
- entity_components (ECS table)
- spatial_ref_sys (postgis table)

the tables displays will be devided by 3 part, i.e general table, ECS table, invisible table

### General table

user can do normal CRUD management to the table, just like normal database table.

### ECS table

user can do CRUD, but not directly to the table. because the ECS table means to be used to work with ECS thing, it will contain multiple entities.
Those entities is what user going to CRUD to.
therefore lets use word table for general table, and entity for ECS table.

ECS system design explanation:
- Entity can be anything e.g user, payment, item, .etc (it can be called as table in traditional design system) it also can be called ArcheType
- fields that usually used in normal system e.g email, phone (for user) or price (for item) .etc in ECS is a Component
- there is 3 table dedicated for ECS i.e entities, components, and entity_components (intermediate table for entities and components)
- entities table contain all entities that exist in the system. the table contain id, created_at, updated_at, and deleted_at
- components table contain the all useful data that user consume, the table contain id, entity_id, type_id, name, data, created_at, updated_at, and deleted_at (data is jsonb that contain the actual useful data)
- entity_components is intermediate table. the table contain, entity_id, type_id, component_id, created_at, updated_at, and deleted_at

## Feature
- for now I only need Read feature, but in the future all CRUD should be supported so we can show the edit/delete ui but can disable it for now
- General table and ECS table should be easily distinguished
- user can create connection to initialize the database connection but there is default value that point to local postgres with default db
- the connection detail is stored in localstorage after created
- user can see the list of tables and entities in the sidebar
- user can click the table or entity to see the data in the main content area
- user can see the table column info (name, type, is_nullable, default value) for General table
- the entity displayed as table, with the columns are id and component types (name from components table), the value for id is from entities.id, and the value for component types is from components.data (jsonb) field
- the default 50 records can be displayed, then there will be load more button to load 50 more records
- user can see the total row count of the table

## Tech stack
- Bun for runtime and package manager
- Vite + React router + @react-router/fs-routes + Tailwind + Shadcn
- tanstack table
- zustand for state management
- sonner for snack/notification
- lucide-react for icon
- zod for schema validation
- react-json-view for json data display

## File structure
- use @react-router/fs-routes see https://reactrouter.com/how-to/file-route-conventions#basic-routes
- components for ui components
- store for zustand store
- ensure its easy to manage and understand

## Api endpoint
- can use /studio/api/tables to get all tables

## Code style
- ensure typesafety with typescript and drizzle orm
- ensure code is clean and easy to understand
- ensure proper error handling
- ensure proper separation of concerns

## App UI style
- for now, only support light theme
- use shadcn available components/template if available
- the theme is orange-ish colour like fire in the sky
- ensure the ui is clean and easy to use
- ensure hover, and focus styles are properly implemented
- only support desktop view for now (min width 1024px)