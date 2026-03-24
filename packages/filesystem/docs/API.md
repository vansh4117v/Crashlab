# @crashlab/filesystem — API Reference

## Responsibility

Replaces Node.js `fs` module functions with an in-memory virtual filesystem backed by **memfs**. Scenarios can pre-populate files, inject I/O errors (e.g. `ENOSPC`, `EIO`) at specific paths, and test filesystem-dependent code paths deterministically. Read operations fall back to the real filesystem on `ENOENT` so bundled assets and `node_modules` remain accessible.

---

## Classes

### `VirtualFS`

#### Constructor

```ts
new VirtualFS(opts?: { clock?: IClock })
```

`clock` is optional and used to timestamp `stat` results with virtual time.

---

### File Seeding

#### `fs.seed(files: Record<string, string | Buffer>): void`

Pre-populate the in-memory volume with files before the scenario runs. Parent directories are created automatically.

```ts
env.fs.seed({
  '/app/config.json': JSON.stringify({ maxRetries: 3 }),
  '/app/data/users.csv': 'id,name\n1,Alice\n2,Bob',
  '/tmp/upload.bin': Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
});
```

---

### Fault Injection

#### `fs.inject(filePath, opts): void`

Inject an I/O error at a specific path. The error is thrown on the next read or write to that path.

```ts
// Simulate disk full on any write to /app/logs
env.fs.inject('/app/logs', { error: 'ENOSPC: no space left on device', code: 'ENOSPC' });

// Simulate corrupt read
env.fs.inject('/app/data/db.sqlite', { error: 'EIO: i/o error', code: 'EIO' });

// Fail only after 3 successful writes (test "disk fills up mid-stream")
env.fs.inject('/app/logs/access.log', {
  error: 'ENOSPC: no space left on device',
  code: 'ENOSPC',
  after: 3,
});
```

**Options:**

| Field | Default | Description |
|-------|---------|-------------|
| `error` | — | Error message |
| `code` | `'EIO'` | `errno` code set on the thrown `Error` |
| `after` | — | Number of successful operations before the error starts |

> `FaultInjector.diskFull(path)` calls `fs.inject(path, { error: 'ENOSPC: no space left on device', code: 'ENOSPC' })` automatically.

---

### Lifecycle

| Method | Description |
|--------|-------------|
| `install()` | Replace all `fs` module exports with memfs counterparts. Called automatically by the simulation worker. |
| `uninstall()` | Restore the original `fs` exports. Called in the worker's `finally` block. |
| `reset()` | Clear all files and injections, recreate the in-memory volume. If currently installed, re-installs automatically. |

---

## Fallback Behaviour

Read-only operations (`readFileSync`, `readFile`, `stat`, `lstat`, `access`, `readdir`, `realpath`, `existsSync`) **fall back to the real filesystem** when the path is not found in the virtual volume. This ensures:

- App source files and configs installed in `node_modules` remain readable.
- Only paths explicitly written to via `seed()` or the app itself are virtualised.
- Errors (e.g. `ENOSPC`) from `inject()` still override the fallback.

---

## Covered `fs` APIs

Both callback (`fs.readFile`, `fs.writeFile`, …) and promise (`fs.promises.readFile`, …) variants are patched, as well as all sync variants:

- `readFileSync` / `readFile` / `promises.readFile`
- `writeFileSync` / `writeFile` / `promises.writeFile`
- `appendFileSync` / `appendFile` / `promises.appendFile`
- `statSync` / `stat` / `lstatSync` / `lstat`
- `existsSync`
- `accessSync` / `access`
- `readdirSync` / `readdir`
- `mkdirSync` / `mkdir`
- `unlinkSync` / `unlink`
- `renameSync` / `rename`
- `rmSync` / `rm`
- `rmdirSync` / `rmdir`
- `chmodSync` / `chmod`
- `realpathSync` / `realpath` / `promises.realpath`
