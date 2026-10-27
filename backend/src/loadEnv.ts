/** Loads a local, gitignored .env when present (dev only). Railway injects real env vars and has no file. Never overrides set vars. */
import { existsSync } from 'node:fs'
if (existsSync('.env')) { try { (process as any).loadEnvFile?.('.env') } catch { /* ignore malformed local file */ } }
