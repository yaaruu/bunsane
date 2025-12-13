export function Welcome() {
  return (
    <div className="p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-primary mb-6">Welcome to BunSane Studio</h1>

        <div className="grid gap-6 md:grid-cols-2">
          <div className="bg-card p-6 rounded-lg border border-border">
            <h2 className="text-2xl font-semibold mb-4">Database Management</h2>
            <p className="text-muted-foreground mb-4">
              Manage your BunSane database with an intuitive interface. View and edit tables,
              explore archetype data, and perform CRUD operations with ease.
            </p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>• Browse traditional database tables</li>
              <li>• Explore ECS archetype data structures</li>
              <li>• Search and filter records</li>
              <li>• Delete records safely</li>
            </ul>
          </div>

          <div className="bg-card p-6 rounded-lg border border-border">
            <h2 className="text-2xl font-semibold mb-4">ECS Architecture</h2>
            <p className="text-muted-foreground mb-4">
              BunSane uses an Entity-Component-System architecture that provides flexibility
              and performance for complex data relationships.
            </p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>• Entities: Unique identifiers</li>
              <li>• Components: Data attached to entities</li>
              <li>• Archetypes: Groups of entities with same components</li>
            </ul>
          </div>
        </div>

        <div className="mt-8 bg-card p-6 rounded-lg border border-border">
          <h2 className="text-2xl font-semibold mb-4">Getting Started</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="text-center">
              <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center mx-auto mb-3">
                <span className="text-primary-foreground font-bold">1</span>
              </div>
              <h3 className="font-medium mb-2">Explore Tables</h3>
              <p className="text-sm text-muted-foreground">
                Click on any table in the sidebar to view its data
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center mx-auto mb-3">
                <span className="text-primary-foreground font-bold">2</span>
              </div>
              <h3 className="font-medium mb-2">Browse Archetypes</h3>
              <p className="text-sm text-muted-foreground">
                Explore entity data grouped by component structure
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 bg-primary rounded-full flex items-center justify-center mx-auto mb-3">
                <span className="text-primary-foreground font-bold">3</span>
              </div>
              <h3 className="font-medium mb-2">Manage Data</h3>
              <p className="text-sm text-muted-foreground">
                Search, filter, and delete records as needed
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}