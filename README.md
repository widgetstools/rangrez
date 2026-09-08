# Rangrez

Monorepo for demo apps and shared npm packages under the `@wellsfargo-starui` namespace.

## Structure

```
rangrez/
├── apps/          # Demo and application projects
│   └── demo/      # Demo app
└── packages/      # Shared npm packages
```

## Getting started

```bash
pnpm install
pnpm dev
```

## Scripts

| Command       | Description                    |
| ------------- | ------------------------------ |
| `pnpm dev`    | Start dev servers              |
| `pnpm build`  | Build all packages and apps    |
| `pnpm lint`   | Lint all workspaces            |
| `pnpm test`   | Run tests across the monorepo  |
| `pnpm clean`  | Clean build artifacts          |

## Adding packages

Create a new package under `packages/<name>/` with its own `package.json`. Workspace packages can depend on each other using `"@wellsfargo-starui/<name>": "workspace:*"`.

## Adding apps

Create a new app under `apps/<name>/` with its own `package.json`.
