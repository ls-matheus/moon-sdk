<p align="center">
  <img src="./assets/moon-sdk-banner.png" alt="Moon SDK — purple moon and stars" width="100%">
</p>

<p align="center">
  <strong>A TypeScript SDK and CLI for portable applications.</strong>
</p>

<p align="center">
  <a href="https://github.com/ls-matheus/moon-sdk/actions/workflows/release-installer.yml"><img src="https://github.com/ls-matheus/moon-sdk/actions/workflows/release-installer.yml/badge.svg?branch=main" alt="Build and publish installers"></a>
  <a href="./tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-5.9.3-3178C6" alt="TypeScript 5.9.3"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-7C3AED" alt="MIT License"></a>
</p>

Moon helps run exported Base44 applications with independent backends: Supabase,
Firebase, PostgreSQL or MySQL. It provides a familiar entity API and a CLI for
database setup, local development and Git synchronization.

Compatibility is still being expanded. Platform-specific services need local
adapters, and existing Base44 data and accounts are not migrated automatically.

## Installation

Requires Node.js 22 and npm. Install directly from GitHub:

```bash
npm install github:ls-matheus/moon-sdk
```

The package name is `@moon/sdk`; it is not currently published on the npm registry.
Prebuilt Windows and macOS installers are available in [Releases](https://github.com/ls-matheus/moon-sdk/releases).

- **Windows:** `install.exe` installs Moon and portable Node.js for your user, without an administrator password.
- **macOS:** extract `Moon-SDK-User-Installer.zip` and open `Moon-SDK-Install.command` for installation without `sudo`. The `.pkg` is the system-wide alternative and requires administrator authorization.

Both user installers configure your user PATH. Open a new terminal after installation.

## Quick Start

Try the entity API with an in-memory database:

```ts
import { createClient, createMemoryAdapter } from '@moon/sdk';

const moon = createClient(createMemoryAdapter());

await moon.entities.Note.create({ title: 'Hello, Moon' });
const notes = await moon.entities.Note.list('-created_date');

console.log(notes);
```

This example keeps data only for the current session. For persistent storage,
follow the [database setup guide](./docs/databases.md).

From your exported application's directory:

```bash
npx moon inspect .
npx moon db .
npx moon run .
```

`inspect` checks known compatibility limits, `db` configures your database and
`run` starts the local backend and frontend.

## Documentation

- [Base44 compatibility and local adapters](./docs/compatibility.md)
- [Database setup and adapters](./docs/databases.md)
- [Synchronization with Base44 and GitHub](./docs/sync.md)
- [Building the Windows installer](./installer/BUILD-WINDOWS.md)
- [Building the macOS installer](./installer/BUILD-MACOS.md)

## Development

```bash
git clone https://github.com/ls-matheus/moon-sdk.git
cd moon-sdk
npm ci
npm run check
npm run audit
```

`npm run check` runs type checking, the build and tests. Use `npm run build` to
rebuild on its own. Tests against external databases require configured services.

`dist/` is versioned because Git installations, the CLI and installers load its
compiled entry points.

## License

[MIT](./LICENSE) © 2026 ls-matheus.
