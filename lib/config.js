import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

// Configuration - all values can be overridden via environment variables
export const CONFIG = {
  // App Store Connect
  appIdentifier: process.env.APP_BUNDLE_ID || 'com.deepdesai.runningorder',
  appName: process.env.APP_NAME || 'Running Order',

  // GitHub repository for PR lookups
  iosRepoOwner: process.env.GITHUB_REPO_OWNER || 'desai-deep',
  iosRepoName: process.env.GITHUB_REPO_NAME || 'runningorder-ios',

  // iOS repo path for git operations
  iosRepoPath: process.env.IOS_REPO_PATH || '',

  // Xcode Cloud workflow name to filter builds
  workflowName: process.env.XCODE_WORKFLOW_NAME || 'Publish to App Store',

  // API (shouldn't need to change)
  apiBaseUrl: 'https://api.appstoreconnect.apple.com/v1',

  // Paths
  rootDir: ROOT_DIR,
};

// Logging
const LOG_FILE = path.join(ROOT_DIR, 'logs', 'merge2fly.log');

export function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `${timestamp} - ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}
