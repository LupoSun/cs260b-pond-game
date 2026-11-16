import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  hostPasscode: string;
  generatedDevPasscode: boolean;
  publicBaseUrl: string;
  enableDevSim: boolean;
}

function loadDotEnvIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function loadServerConfig(): ServerConfig {
  loadDotEnvIfPresent();

  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const configuredPasscode = (process.env.HOST_PASSCODE || '').trim();

  if (isProd && !configuredPasscode) {
    throw new Error(
      'HOST_PASSCODE environment variable is required when NODE_ENV=production. Configure it in .env before starting.',
    );
  }

  const generatedDevPasscode = !configuredPasscode;
  const hostPasscode =
    configuredPasscode || `dev-${crypto.randomBytes(4).toString('hex')}`;

  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const enableDevSim = process.env.ENABLE_DEV_SIM === 'true';

  return {
    port,
    host,
    hostPasscode,
    generatedDevPasscode,
    publicBaseUrl,
    enableDevSim,
  };
}
