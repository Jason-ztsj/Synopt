import crypto from 'node:crypto';

import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { createGovernanceService } from './governance.js';

const username = process.argv[2];
if (!username || process.argv.length > 3) {
  console.error('用法：npm run admin:grant -- <username>');
  process.exitCode = 2;
} else {
  const config = loadConfig(process.env, process.cwd());
  const database = openDatabase(config.databasePath);
  try {
    const service = createGovernanceService(database.governance, {
      appealWindowMs: config.appealWindowMs,
      mediaGrantMs: config.cmsPrivateMediaGrantMs
    });
    const user = service.grantAdministratorByUsername(username, {
      requestId: `cli-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString()
    });
    console.log(`已授予管理员：@${user.username}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
