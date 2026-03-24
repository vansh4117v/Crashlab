# @crashlab/redis-mock

Redis RESP protocol mock for CrashLab. Supports 16 commands: GET, SET, DEL, EXPIRE, TTL, INCR, DECR, LPUSH, RPUSH, LPOP, RPOP, HSET, HGET, SMEMBERS, SADD, ZADD, ZRANGE. TTL integrates with virtual clock. Throws `CrashLabUnsupportedRedisCommand` for unsupported commands.
