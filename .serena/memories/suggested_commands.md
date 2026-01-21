# Suggested Commands

## Development Commands

### Running Tests
```bash
# Run all tests
bun test

# Run specific test file
bun test path/to/file.test.ts

# Run tests matching a pattern
bun test --filter "pattern"
```

Test configuration is in `bunfig.toml`:
- Preloads `./test/setup.ts` for database initialization
- 30-second timeout for integration tests
- Uses `smol = true` to limit parallelism (avoids DB connection pool exhaustion)

### Building
```bash
# Full build (includes studio)
bun run build

# Build studio only
bun run build:studio

# Watch mode for development
bun run dev
```

### Type Checking
```bash
# Run TypeScript compiler
tsc

# Watch mode
tsc --watch
```

### Dead Code Detection
```bash
# Run knip for dead code detection
bunx knip
```

## Git Commands (Windows)
```bash
git status
git add .
git commit -m "message"
git push
git pull
git log --oneline -10
```

## File Operations (Windows)
```bash
# List directory
dir
ls  # works in Git Bash / PowerShell

# Find files
dir /s /b *.ts
Get-ChildItem -Recurse -Filter "*.ts"  # PowerShell

# Search in files
findstr /s /i "pattern" *.ts
Select-String -Path "*.ts" -Pattern "pattern" -Recurse  # PowerShell
```

## Database
The framework uses PostgreSQL. Ensure a PostgreSQL instance is running and configured via `.env.test` or environment variables.

## Environment Setup
1. Copy `.env.test` to `.env` for local development
2. Configure PostgreSQL connection
3. Run `bun install` for dependencies
