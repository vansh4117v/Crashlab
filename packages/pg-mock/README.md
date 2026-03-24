# @crashlab/pg-mock

PostgreSQL wire protocol v3 mock for CrashLab. Supports startup handshake (no SSL), simple query protocol, RowDescription/DataRow/CommandComplete, BEGIN/COMMIT/ROLLBACK, and basic SQL patterns (SELECT/INSERT/UPDATE/DELETE with WHERE). Throws `CrashLabUnsupportedPGFeature` for unsupported features. Plugs into `@crashlab/tcp` as a handler.
