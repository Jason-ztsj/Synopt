import { pathToFileURL } from 'node:url';
import { startServer } from './app.js';

export { createApp, startServer } from './app.js';

async function main() {
  const running = await startServer();
  const address = running.address;
  const shownHost = typeof address === 'object' && address?.address === '::' ? '0.0.0.0' : address?.address;
  console.log(`共映已启动：http://${shownHost}:${address.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await running.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`共映启动失败：${error.message}`);
    process.exitCode = 1;
  });
}

