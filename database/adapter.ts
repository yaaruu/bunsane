export interface DatabaseAdapter {
    query(sql: string, params?: any[]): Promise<any[]>;
    begin(fn: (sql: any) => Promise<void>): Promise<void>;
    unsafe(sql: string): Promise<any[]>;
}

export class PostgreSQLAdapter implements DatabaseAdapter {
    constructor(private db: any) {}

    async query(sql: string, params?: any[]): Promise<any[]> {
        // Implement parameterized query
        return this.db(sql, params);
    }

    async begin(fn: (sql: any) => Promise<void>): Promise<void> {
        await this.db.begin(fn);
    }

    async unsafe(sql: string): Promise<any[]> {
        return this.db.unsafe(sql);
    }
}