import { buildApp } from './app.js';
import { LOOPBACK_HOST, readConfig } from './config.js';

try {
  const { port, ...options } = readConfig(process.env);
  const app = await buildApp(options);
  try {
    await app.listen({ port, host: LOOPBACK_HOST });
    const stop = () => {
      void app.close().catch(() => {
        console.error('Atlas API shutdown failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await app.close();
    throw error;
  }
} catch {
  console.error(
    'Atlas API could not start. Check the loopback port, database path and Worker token configuration.',
  );
  process.exitCode = 1;
}
