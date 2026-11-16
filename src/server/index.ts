import { loadServerConfig } from './config.js';
import { createPondServer } from './createServer.js';

async function main(): Promise<void> {
  const config = loadServerConfig();
  const running = await createPondServer(config);

  const base = config.publicBaseUrl || `http://${config.host}:${running.port}`;
  console.log(`[pond-server] Listening on http://${config.host}:${running.port}`);
  console.log(`[pond-server] Participant URL:   ${base}/play`);
  console.log(`[pond-server] Classroom Display: ${base}/screen`);
  console.log(`[pond-server] Mission Control:   ${base}/control`);
  console.log(`[pond-server] Sensor Lab (Gate A): ${base}/lab`);
  console.log(`[pond-server] Dev Simulation Enabled: ${config.enableDevSim}`);

  if (config.generatedDevPasscode) {
    console.log(
      `[pond-server] Generated temporary dev HOST_PASSCODE (set HOST_PASSCODE in .env for classroom deployment): ${config.hostPasscode}`,
    );
  } else {
    console.log('[pond-server] Using configured HOST_PASSCODE from environment.');
  }

  const shutdown = async (sig: string) => {
    console.log(`[pond-server] Received ${sig}, shutting down cleanly...`);
    await running.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[pond-server] Fatal startup error:', err);
  process.exit(1);
});
