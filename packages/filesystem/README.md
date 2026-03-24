# @crashlab/filesystem

In-memory virtual filesystem for CrashLab. Patches `fs.readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `readdirSync`, `unlinkSync`, and `statSync`. Supports error injection (ENOSPC, EIO) with optional after-N-writes thresholds.
