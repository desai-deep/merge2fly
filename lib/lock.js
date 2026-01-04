import fs from 'fs';
import path from 'path';
import { CONFIG, log } from './config.js';

const LOCK_FILE = path.join(CONFIG.rootDir, '.merge2fly.lock');
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stats = fs.statSync(LOCK_FILE);
      const age = Date.now() - stats.mtimeMs;

      if (age > LOCK_MAX_AGE_MS) {
        log(`Removing stale lock (age: ${Math.round(age / 1000)}s)`);
        fs.unlinkSync(LOCK_FILE);
      } else {
        return false;
      }
    }

    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch (e) {
    return false;
  }
}

export function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    log(`Warning: Failed to remove lock file: ${e.message}`);
  }
}
