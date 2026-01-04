#!/usr/bin/env node

/**
 * merge2fly - iOS App Store Deployment & Release Sync
 *
 * Combined script that:
 * 1. Monitors TestFlight builds and submits them to App Store review (deploy)
 * 2. Tags releases when they go live in the App Store (release sync)
 *
 * Usage:
 *   node index.js                    # Run both operations
 *   node index.js deploy             # Run only deployment check
 *   node index.js sync               # Run only release sync
 *   DRY_RUN=true node index.js       # Dry run mode
 *
 * Required environment variables:
 *   APP_STORE_CONNECT_API_KEY_ID      - App Store Connect API Key ID
 *   APP_STORE_CONNECT_ISSUER_ID       - App Store Connect Issuer ID
 *   APP_STORE_CONNECT_API_KEY_CONTENT - API private key (base64 encoded)
 *   IOS_REPO_PATH                     - Path to iOS git repository (for tagging)
 *
 * Optional environment variables:
 *   GH_TOKEN / GITHUB_TOKEN           - GitHub token for PR comments (used by gh CLI)
 *   DRY_RUN=true                      - Run without making changes
 *
 * App configuration (override defaults for other apps):
 *   APP_BUNDLE_ID                     - Bundle ID (default: com.deepdesai.runningorder)
 *   APP_NAME                          - App name for logging (default: Running Order)
 *   GITHUB_REPO_OWNER                 - GitHub org/user (default: desai-deep)
 *   GITHUB_REPO_NAME                  - GitHub repo name (default: runningorder-ios)
 *   XCODE_WORKFLOW_NAME               - Xcode Cloud workflow to process (default: Publish to App Store)
 */

// Suppress dotenv logging
process.env.DOTENV_CONFIG_QUIET = 'true';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

// Lock file to prevent concurrent runs
const LOCK_FILE = path.join(__dirname, '.merge2fly.lock');
const LOCK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// Configuration - all values can be overridden via environment variables
const CONFIG = {
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
};

// Logging
const LOG_FILE = path.join(__dirname, 'logs', 'merge2fly.log');

function log(message) {
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

// ============================================================================
// App Store Connect API Client
// ============================================================================

class AppStoreConnectAPI {
  constructor(keyId, issuerId, privateKeyContent) {
    this.keyId = keyId;
    this.issuerId = issuerId;
    this.privateKey = Buffer.from(privateKeyContent, 'base64').toString('utf8');
    this.token = null;
    this.tokenExpiry = null;
    this.appId = null;
  }

  generateToken() {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 20 * 60; // 20 minutes

    if (this.token && this.tokenExpiry && now < this.tokenExpiry - 60) {
      return this.token;
    }

    const header = {
      alg: 'ES256',
      kid: this.keyId,
      typ: 'JWT'
    };

    const payload = {
      iss: this.issuerId,
      iat: now,
      exp: expiry,
      aud: 'appstoreconnect-v1'
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.privateKey);

    // Convert DER signature to raw r||s format for ES256
    const rawSignature = this.derToRaw(signature);
    const signatureB64 = rawSignature.toString('base64url');

    this.token = `${signatureInput}.${signatureB64}`;
    this.tokenExpiry = expiry;
    return this.token;
  }

  derToRaw(derSignature) {
    // Parse DER signature and extract r and s values
    let offset = 0;
    if (derSignature[offset++] !== 0x30) throw new Error('Invalid DER signature');

    let length = derSignature[offset++];
    if (length & 0x80) offset += (length & 0x7f);

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let rLength = derSignature[offset++];
    let r = derSignature.slice(offset, offset + rLength);
    offset += rLength;

    if (derSignature[offset++] !== 0x02) throw new Error('Invalid DER signature');
    let sLength = derSignature[offset++];
    let s = derSignature.slice(offset, offset + sLength);

    // Remove leading zeros and pad to 32 bytes
    while (r.length > 32 && r[0] === 0) r = r.slice(1);
    while (s.length > 32 && s[0] === 0) s = s.slice(1);
    while (r.length < 32) r = Buffer.concat([Buffer.from([0]), r]);
    while (s.length < 32) s = Buffer.concat([Buffer.from([0]), s]);

    return Buffer.concat([r, s]);
  }

  async request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${CONFIG.apiBaseUrl}${endpoint}`;
    const token = this.generateToken();

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (response.status === 204) {
      return null;
    }

    const data = await response.json();

    if (!response.ok) {
      const errorDetail = data.errors?.[0]?.detail || JSON.stringify(data);
      throw new Error(`API Error ${response.status}: ${errorDetail}`);
    }

    return data;
  }

  async getAppId() {
    if (this.appId) return this.appId;

    const data = await this.request(`/apps?filter[bundleId]=${CONFIG.appIdentifier}`);
    if (!data.data?.[0]) {
      throw new Error(`App not found: ${CONFIG.appIdentifier}`);
    }
    this.appId = data.data[0].id;
    return this.appId;
  }

  // Get all App Store versions
  async getAppStoreVersions() {
    const appId = await this.getAppId();
    const data = await this.request(`/apps/${appId}/appStoreVersions?include=build`);
    return data;
  }

  // Check if any build is in review
  async checkBuildInReview() {
    const versions = await this.getAppStoreVersions();
    const reviewStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'];

    for (const version of versions.data || []) {
      if (reviewStates.includes(version.attributes.appStoreState)) {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = 'unknown';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || 'unknown';
        }

        return {
          inReview: true,
          version: version.attributes.versionString,
          state: version.attributes.appStoreState,
          buildNumber,
          versionId: version.id,
        };
      }
    }

    return { inReview: false };
  }

  // Check for rejected versions
  async checkRejectedVersion() {
    const versions = await this.getAppStoreVersions();
    const rejectedStates = ['REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'];

    for (const version of versions.data || []) {
      if (rejectedStates.includes(version.attributes.appStoreState)) {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = 'unknown';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || 'unknown';
        }

        return {
          rejected: true,
          version: version.attributes.versionString,
          state: version.attributes.appStoreState,
          buildNumber,
          versionId: version.id,
        };
      }
    }

    return { rejected: false };
  }

  // Get live production build
  async getLiveProductionBuild() {
    const versions = await this.getAppStoreVersions();

    for (const version of versions.data || []) {
      if (version.attributes.appStoreState === 'READY_FOR_SALE') {
        const buildId = version.relationships?.build?.data?.id;
        let buildNumber = '0';

        if (buildId && versions.included) {
          const build = versions.included.find(i => i.type === 'builds' && i.id === buildId);
          buildNumber = build?.attributes?.version || '0';
        }

        return {
          live: true,
          version: version.attributes.versionString,
          buildNumber,
        };
      }
    }

    return { live: false, buildNumber: '0' };
  }

  // Get latest TestFlight build ready for App Store submission
  async getLatestTestFlightReadyBuild() {
    const appId = await this.getAppId();

    // Get builds with beta details
    const data = await this.request(
      `/builds?filter[app]=${appId}&sort=-uploadedDate&limit=50&include=preReleaseVersion,buildBetaDetail`
    );

    // Get versions to check what's already submitted/live
    const versions = await this.getAppStoreVersions();
    const liveVersion = versions.data?.find(v => v.attributes.appStoreState === 'READY_FOR_SALE');
    const liveBuildId = liveVersion?.relationships?.build?.data?.id;

    const reviewStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PREPARE_FOR_SUBMISSION'];
    const inProgressVersion = versions.data?.find(v => reviewStates.includes(v.attributes.appStoreState));
    const inProgressBuildId = inProgressVersion?.relationships?.build?.data?.id;

    for (const build of data.data || []) {
      // Skip if not valid
      if (build.attributes.processingState !== 'VALID') continue;
      // Skip if expired
      if (build.attributes.expired) continue;
      // Skip if it's the live build
      if (build.id === liveBuildId) continue;
      // Skip if it's already in progress
      if (build.id === inProgressBuildId) continue;

      // Get version string from preReleaseVersion
      const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;
      let versionString = 'unknown';
      if (preReleaseVersionId && data.included) {
        const preRelease = data.included.find(i => i.type === 'preReleaseVersions' && i.id === preReleaseVersionId);
        versionString = preRelease?.attributes?.version || 'unknown';
      }

      // Check beta approval status
      const betaDetailId = build.relationships?.buildBetaDetail?.data?.id;
      let betaState = 'unknown';
      if (betaDetailId && data.included) {
        const betaDetail = data.included.find(i => i.type === 'buildBetaDetails' && i.id === betaDetailId);
        betaState = betaDetail?.attributes?.externalBuildState || 'unknown';
      }

      return {
        found: true,
        buildNumber: build.attributes.version,
        version: versionString,
        betaState,
        buildId: build.id,
      };
    }

    return { found: false };
  }

  // Get CI products (Xcode Cloud)
  async getCIProducts() {
    const data = await this.request('/ciProducts');
    return data.data || [];
  }

  // Get workflows for a CI product
  async getWorkflows(productId) {
    const data = await this.request(`/ciProducts/${productId}/workflows`);
    return data.data || [];
  }

  // Get build runs for a workflow
  async getBuildRuns(workflowId, limit = 50) {
    const data = await this.request(
      `/ciWorkflows/${workflowId}/buildRuns?limit=${limit}&sort=-number&fields[ciBuildRuns]=number,sourceCommit,executionProgress,completionStatus`
    );
    return data;
  }

  // Get commit SHA for a build number from Xcode Cloud
  async getBuildCommitSHA(buildNumber) {
    const products = await this.getCIProducts();

    for (const product of products) {
      const workflows = await this.getWorkflows(product.id);

      for (const workflow of workflows) {
        const workflowName = workflow.attributes?.name;
        const runsData = await this.getBuildRuns(workflow.id, 200);

        for (const run of runsData.data || []) {
          if (run.attributes?.number?.toString() === buildNumber.toString()) {
            const sourceCommit = run.attributes?.sourceCommit;
            let commitSha = null;

            if (typeof sourceCommit === 'string') {
              commitSha = sourceCommit;
            } else if (sourceCommit && typeof sourceCommit === 'object') {
              commitSha = sourceCommit.commitSha || sourceCommit.hash || sourceCommit.canonicalHash || sourceCommit.id;
            }

            return {
              found: true,
              commitSha,
              workflowName,
            };
          }
        }
      }
    }

    return { found: false };
  }

  // Cancel review submission
  async cancelReview(versionId) {
    // First get the submission
    const submissionData = await this.request(`/appStoreVersions/${versionId}/appStoreVersionSubmission`);

    if (!submissionData?.data?.id) {
      return { success: false, error: 'No submission found' };
    }

    // Delete the submission to cancel review
    await this.request(`/appStoreVersionSubmissions/${submissionData.data.id}`, {
      method: 'DELETE',
    });

    return { success: true };
  }

  // Get or create App Store version
  async getOrCreateAppStoreVersion(versionString) {
    const appId = await this.getAppId();
    const versions = await this.getAppStoreVersions();

    // Check if version exists
    const existingVersion = versions.data?.find(
      v => v.attributes.versionString === versionString
    );

    if (existingVersion) {
      return {
        exists: true,
        versionId: existingVersion.id,
        state: existingVersion.attributes.appStoreState,
      };
    }

    // Create new version
    const createData = await this.request('/appStoreVersions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: 'IOS',
            versionString,
          },
          relationships: {
            app: {
              data: {
                type: 'apps',
                id: appId,
              },
            },
          },
        },
      }),
    });

    return {
      exists: false,
      versionId: createData.data.id,
      state: createData.data.attributes.appStoreState,
    };
  }

  // Select build for version
  async selectBuildForVersion(versionId, buildId) {
    await this.request(`/appStoreVersions/${versionId}/relationships/build`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'builds',
          id: buildId,
        },
      }),
    });
  }

  // Update release notes (What's New)
  async updateReleaseNotes(versionId, releaseNotes, locale = 'en-US') {
    // Get localization
    const localizationsData = await this.request(
      `/appStoreVersions/${versionId}/appStoreVersionLocalizations`
    );

    let localization = localizationsData.data?.find(
      l => l.attributes.locale === locale
    );

    if (localization) {
      // Update existing localization
      await this.request(`/appStoreVersionLocalizations/${localization.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            id: localization.id,
            attributes: {
              whatsNew: releaseNotes,
            },
          },
        }),
      });
    } else {
      // Create new localization
      await this.request('/appStoreVersionLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: {
              locale,
              whatsNew: releaseNotes,
            },
            relationships: {
              appStoreVersion: {
                data: {
                  type: 'appStoreVersions',
                  id: versionId,
                },
              },
            },
          },
        }),
      });
    }
  }

  // Submit for review
  async submitForReview(versionId) {
    await this.request('/appStoreVersionSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersionSubmissions',
          relationships: {
            appStoreVersion: {
              data: {
                type: 'appStoreVersions',
                id: versionId,
              },
            },
          },
        },
      }),
    });
  }

  // Get build by build number
  async getBuildByNumber(buildNumber) {
    const appId = await this.getAppId();
    const data = await this.request(
      `/builds?filter[app]=${appId}&filter[version]=${buildNumber}&include=preReleaseVersion&limit=1`
    );

    if (!data.data?.[0]) {
      return null;
    }

    const build = data.data[0];
    const preReleaseVersionId = build.relationships?.preReleaseVersion?.data?.id;
    let versionString = 'unknown';

    if (preReleaseVersionId && data.included) {
      const preRelease = data.included.find(i => i.type === 'preReleaseVersions' && i.id === preReleaseVersionId);
      versionString = preRelease?.attributes?.version || 'unknown';
    }

    return {
      buildId: build.id,
      buildNumber: build.attributes.version,
      version: versionString,
      processingState: build.attributes.processingState,
    };
  }
}

// ============================================================================
// GitHub Integration
// ============================================================================

class GitHubAPI {
  constructor(repoOwner, repoName) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
  }

  // Find PR from merge commit using gh CLI
  findPRFromCommit(commitSha) {
    try {
      // Try gh CLI first
      const result = execSync(
        `gh pr list --repo ${this.repoOwner}/${this.repoName} --state merged --base main --json number,mergeCommit --jq '.[] | select(.mergeCommit.oid == "${commitSha}") | .number'`,
        { encoding: 'utf8', timeout: 30000 }
      ).trim();

      if (result) {
        return result.split('\n')[0];
      }
    } catch (e) {
      // Fallback: try to extract from commit message
      try {
        const commitMsg = execSync(
          `gh api repos/${this.repoOwner}/${this.repoName}/commits/${commitSha} --jq '.commit.message'`,
          { encoding: 'utf8', timeout: 30000 }
        ).trim();

        // Match "(#123)" pattern
        const match = commitMsg.match(/\(#(\d+)\)/);
        if (match) return match[1];

        // Match "Merge pull request #123" pattern
        const mergeMatch = commitMsg.match(/pull request #(\d+)/);
        if (mergeMatch) return mergeMatch[1];
      } catch (e2) {
        // Ignore
      }
    }

    return null;
  }

  // Get PR details
  getPRDetails(prNumber) {
    try {
      const result = execSync(
        `gh pr view ${prNumber} --repo ${this.repoOwner}/${this.repoName} --json title,body`,
        { encoding: 'utf8', timeout: 30000 }
      );
      return JSON.parse(result);
    } catch (e) {
      return null;
    }
  }

  // Extract release notes from PR
  extractReleaseNotes(prBody, prTitle) {
    if (prBody) {
      // Try to extract ## Release Notes section
      const match = prBody.match(/^##?\s*Release Notes\s*\n([\s\S]*?)(?=\n#|$)/im);
      if (match) {
        const notes = match[1].trim();
        if (notes) return notes;
      }
    }

    // Fallback to PR title
    return prTitle || 'Bug fixes and improvements';
  }

  // Add comment to PR
  addPRComment(prNumber, comment) {
    try {
      execSync(
        `gh pr comment ${prNumber} --repo ${this.repoOwner}/${this.repoName} --body "${comment.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', timeout: 30000 }
      );
      return true;
    } catch (e) {
      return false;
    }
  }
}

// ============================================================================
// Git Operations (for release sync)
// ============================================================================

class GitOperations {
  constructor(repoPath) {
    this.repoPath = repoPath;
  }

  exec(command) {
    return execSync(command, {
      cwd: this.repoPath,
      encoding: 'utf8',
      timeout: 60000,
    }).trim();
  }

  // Fetch latest from origin
  fetch() {
    this.exec('git fetch origin main develop --tags');
  }

  // Check if tag exists
  tagExists(tagName) {
    try {
      this.exec(`git rev-parse ${tagName}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Check if commit exists
  commitExists(commitSha) {
    try {
      this.exec(`git cat-file -e ${commitSha}`);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Resolve reference to commit SHA
  resolveRef(ref) {
    try {
      return this.exec(`git rev-parse ${ref}`);
    } catch (e) {
      try {
        return this.exec(`git rev-parse origin/${ref}`);
      } catch (e2) {
        return null;
      }
    }
  }

  // Get commit message
  getCommitMessage(commitSha) {
    try {
      return this.exec(`git log -1 --pretty=%s ${commitSha}`);
    } catch (e) {
      return '';
    }
  }

  // Create annotated tag
  createTag(tagName, commitSha, message) {
    this.exec(`git tag -a "${tagName}" ${commitSha} -m "${message.replace(/"/g, '\\"')}"`);
  }

  // Push tag to origin
  pushTag(tagName) {
    this.exec(`git push origin ${tagName}`);
  }
}

// ============================================================================
// Lock Management
// ============================================================================

function acquireLock() {
  try {
    // Check if lock exists and is stale
    if (fs.existsSync(LOCK_FILE)) {
      const stats = fs.statSync(LOCK_FILE);
      const age = Date.now() - stats.mtimeMs;

      if (age > LOCK_MAX_AGE_MS) {
        log(`Removing stale lock (age: ${Math.round(age / 1000)}s)`);
        fs.unlinkSync(LOCK_FILE);
      } else {
        return false; // Lock is held by another process
      }
    }

    // Create lock file with PID
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch (e) {
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (e) {
    log(`Warning: Failed to remove lock file: ${e.message}`);
  }
}

// ============================================================================
// Deploy Check - Submit builds for App Store review
// ============================================================================

async function runDeployCheck(asc, github, DRY_RUN) {
  log('--- Deploy Check ---');

  // Step 1: Check if a build is already in review
  log('Checking if a build is already in review...');
  const reviewStatus = await asc.checkBuildInReview();

  if (reviewStatus.inReview) {
    log(`Build #${reviewStatus.buildNumber} (v${reviewStatus.version}) is currently ${reviewStatus.state}`);
  }

  // Step 2: Get latest TestFlight build ready for submission
  log('Checking for latest TestFlight build...');
  const latestBuild = await asc.getLatestTestFlightReadyBuild();

  if (!latestBuild.found) {
    log('No TestFlight builds ready for App Store submission');
    return;
  }

  log(`Latest TestFlight build: #${latestBuild.buildNumber} (v${latestBuild.version})`);

  // Step 3: Check if this build is already live
  log('Checking if build is already live...');
  const liveStatus = await asc.getLiveProductionBuild();

  if (liveStatus.live && liveStatus.buildNumber === latestBuild.buildNumber) {
    log(`Build ${latestBuild.buildNumber} is already live in production`);
    return;
  }

  // Step 4: Get commit SHA for this build from Xcode Cloud
  log(`Getting commit SHA for build #${latestBuild.buildNumber}...`);
  const commitInfo = await asc.getBuildCommitSHA(latestBuild.buildNumber);

  if (!commitInfo.found || !commitInfo.commitSha) {
    log(`No commit SHA found for build #${latestBuild.buildNumber}`);
    return;
  }

  // Step 5: Check which workflow built this
  if (commitInfo.workflowName !== CONFIG.workflowName) {
    log(`Build #${latestBuild.buildNumber} is from '${commitInfo.workflowName}' workflow, not '${CONFIG.workflowName}' - skipping`);
    return;
  }

  log(`Build #${latestBuild.buildNumber} is from '${CONFIG.workflowName}' workflow`);
  log(`Build #${latestBuild.buildNumber} is from commit: ${commitInfo.commitSha.substring(0, 7)}`);

  // Step 6: Find the PR that introduced this commit
  const prNumber = github.findPRFromCommit(commitInfo.commitSha);
  let releaseNotes = 'Bug fixes and improvements';

  if (prNumber) {
    log(`Found PR #${prNumber} for this build`);

    const prDetails = github.getPRDetails(prNumber);
    if (prDetails) {
      releaseNotes = github.extractReleaseNotes(prDetails.body, prDetails.title);
      log(`Release notes from PR #${prNumber}: ${releaseNotes}`);
    }

    // Step 7: Handle existing review
    if (reviewStatus.inReview) {
      const reviewBuildNum = parseInt(reviewStatus.buildNumber, 10);
      const latestBuildNum = parseInt(latestBuild.buildNumber, 10);

      if (isNaN(reviewBuildNum) || isNaN(latestBuildNum)) {
        log('Non-numeric build number detected, skipping to avoid conflicts');
        return;
      }

      if (latestBuildNum <= reviewBuildNum) {
        if (latestBuildNum === reviewBuildNum) {
          log(`Build #${reviewStatus.buildNumber} is already in review - no newer build available`);
        } else {
          log(`Warning: Build #${reviewStatus.buildNumber} in review is newer than latest main branch build #${latestBuild.buildNumber}`);
        }
        return;
      }

      // Newer build available - cancel current review
      log(`Newer build #${latestBuild.buildNumber} from PR #${prNumber} available (current in review: #${reviewStatus.buildNumber})`);

      if (DRY_RUN) {
        log(`[DRY RUN] Would cancel review for build #${reviewStatus.buildNumber} (v${reviewStatus.version})`);
        log(`[DRY RUN] Would look up cancelled build's PR to notify`);
      } else {
        log('Cancelling current review to submit newer build...');
        const cancelResult = await asc.cancelReview(reviewStatus.versionId);

        if (cancelResult.success) {
          log(`Successfully cancelled review for build #${reviewStatus.buildNumber}`);

          // Try to find and comment on the cancelled build's PR
          try {
            const cancelledCommitInfo = await asc.getBuildCommitSHA(reviewStatus.buildNumber);
            if (cancelledCommitInfo.found && cancelledCommitInfo.commitSha) {
              const cancelledPrNumber = github.findPRFromCommit(cancelledCommitInfo.commitSha);
              if (cancelledPrNumber && cancelledPrNumber !== prNumber) {
                const cancelComment = `Build #${reviewStatus.buildNumber} has been withdrawn from App Store review.\n\nA newer build #${latestBuild.buildNumber} from PR #${prNumber} has been submitted instead.`;
                if (github.addPRComment(cancelledPrNumber, cancelComment)) {
                  log(`Added cancellation notice to PR #${cancelledPrNumber}`);
                }
              }
            }
          } catch (e) {
            log(`Warning: Could not notify cancelled build's PR: ${e.message}`);
          }
        } else {
          log(`Failed to cancel review: ${cancelResult.error}`);
          return;
        }
      }
    }
  } else {
    // No PR found
    if (reviewStatus.inReview) {
      log(`Build #${latestBuild.buildNumber} is not from a merged PR, skipping (build #${reviewStatus.buildNumber} already in review)`);
      return;
    }
    log('No PR found for commit, using default release notes');
  }

  // Step 8: Submit build for review
  if (DRY_RUN) {
    log(`[DRY RUN] Would submit build #${latestBuild.buildNumber} for review`);
    log(`[DRY RUN] Release notes: ${releaseNotes}`);
  } else {
    log(`Submitting build #${latestBuild.buildNumber} for review...`);

    // Get the build details
    const buildDetails = await asc.getBuildByNumber(latestBuild.buildNumber);
    if (!buildDetails) {
      log(`ERROR: Build #${latestBuild.buildNumber} not found`);
      return;
    }

    // Get or create the version
    const versionInfo = await asc.getOrCreateAppStoreVersion(buildDetails.version);
    log(`Version ${buildDetails.version}: ${versionInfo.exists ? 'exists' : 'created'} (state: ${versionInfo.state})`);

    // Check if we can submit
    const submittableStates = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED'];
    if (!submittableStates.includes(versionInfo.state)) {
      if (versionInfo.state === 'WAITING_FOR_REVIEW' || versionInfo.state === 'IN_REVIEW') {
        log(`Version ${buildDetails.version} is already in ${versionInfo.state} state`);
        return;
      }
      log(`ERROR: Cannot submit version in state: ${versionInfo.state}`);
      return;
    }

    // Select the build
    log(`Selecting build ${latestBuild.buildNumber}...`);
    await asc.selectBuildForVersion(versionInfo.versionId, buildDetails.buildId);

    // Update release notes
    log('Updating release notes...');
    await asc.updateReleaseNotes(versionInfo.versionId, releaseNotes);

    // Submit for review
    log('Submitting for review...');
    await asc.submitForReview(versionInfo.versionId);

    log(`Successfully submitted build #${latestBuild.buildNumber} for App Store review!`);
    log(`Release notes: ${releaseNotes}`);

    // Add comment to PR
    if (prNumber) {
      const comment = `Build #${latestBuild.buildNumber} has been submitted to App Store for review.\n\n**Release Notes:**\n${releaseNotes}`;
      if (github.addPRComment(prNumber, comment)) {
        log(`Added comment to PR #${prNumber}`);
      }
    }
  }

  log('Deploy check complete');
}

// ============================================================================
// Release Sync - Tag builds when they go live
// ============================================================================

async function runReleaseSync(asc, git, github, DRY_RUN) {
  log('--- Release Sync ---');

  // Check if IOS_REPO_PATH is configured
  if (!CONFIG.iosRepoPath) {
    log('IOS_REPO_PATH not configured - skipping release sync');
    return;
  }

  // Step 1: Get live production build
  log('Checking for live production build...');
  const liveStatus = await asc.getLiveProductionBuild();

  if (!liveStatus.live || liveStatus.buildNumber === '0') {
    log('No live production build found (app may not be released yet)');
    return;
  }

  log(`Live production build: #${liveStatus.buildNumber} (v${liveStatus.version})`);

  // Validate version format
  if (!/^\d+\.\d+(\.\d+)?$/.test(liveStatus.version)) {
    log(`ERROR: Invalid version format: ${liveStatus.version}`);
    return;
  }

  // Step 2: Check if tag already exists
  const tagName = `v${liveStatus.version}-${liveStatus.buildNumber}`;
  log(`Checking if tag ${tagName} already exists...`);

  git.fetch();

  if (git.tagExists(tagName)) {
    log(`Tag ${tagName} already exists - build already synced`);
    return;
  }

  log(`New production release detected: build #${liveStatus.buildNumber}`);

  // Step 3: Get commit SHA for this build
  log(`Getting commit SHA for build #${liveStatus.buildNumber}...`);
  const commitInfo = await asc.getBuildCommitSHA(liveStatus.buildNumber);

  if (!commitInfo.found || !commitInfo.commitSha) {
    log(`No commit SHA found for build #${liveStatus.buildNumber}`);
    log('This build may have been submitted before commit tracking was implemented');
    return;
  }

  let commitSha = commitInfo.commitSha;
  log(`Found commit reference: ${commitSha}`);

  // Step 4: Resolve to full commit SHA if needed
  if (!/^[0-9a-fA-F]{40}$/.test(commitSha)) {
    log(`Resolving reference ${commitSha} to commit SHA...`);
    const resolved = git.resolveRef(commitSha);

    if (!resolved) {
      log(`Could not resolve reference '${commitSha}' to a commit`);
      return;
    }

    commitSha = resolved;
    log(`Resolved to commit SHA: ${commitSha}`);
  }

  // Step 5: Verify commit exists
  if (!git.commitExists(commitSha)) {
    log(`ERROR: Commit ${commitSha} not found in repository`);
    return;
  }

  const commitMsg = git.getCommitMessage(commitSha);
  log(`Commit message: ${commitMsg}`);

  // Step 6: Create and push tag
  if (DRY_RUN) {
    log(`[DRY RUN] Would create tag ${tagName} on commit ${commitSha.substring(0, 7)}`);
    log(`[DRY RUN] Would push tag to origin`);
  } else {
    log(`Creating tag ${tagName}...`);
    git.createTag(tagName, commitSha, `Production release: version ${liveStatus.version}, build ${liveStatus.buildNumber}`);

    log(`Pushing tag ${tagName}...`);
    git.pushTag(tagName);

    log(`Created and pushed tag ${tagName}`);
  }

  // Step 7: Comment on the PR
  const prNumber = github.findPRFromCommit(commitSha);

  if (prNumber) {
    if (DRY_RUN) {
      log(`[DRY RUN] Would add release comment to PR #${prNumber}`);
    } else {
      const comment = `Build #${liveStatus.buildNumber} has been released to the App Store as version ${liveStatus.version}.`;
      if (github.addPRComment(prNumber, comment)) {
        log(`Added release comment to PR #${prNumber}`);
      }
    }
  }

  log(`Successfully synced build #${liveStatus.buildNumber} and tagged as ${tagName}`);
  log('Release sync complete');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const args = process.argv.slice(2);
  const mode = args[0] || 'all'; // 'deploy', 'sync', or 'all'

  // Acquire lock
  if (!acquireLock()) {
    log('Another instance is already running, exiting');
    process.exit(0);
  }

  // Ensure lock is released on exit
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('=== merge2fly ===');
  log(`Mode: ${mode}`);
  if (DRY_RUN) {
    log('DRY RUN MODE - No actual changes will be made');
  }

  // Validate required environment variables
  const requiredVars = [
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
  ];

  // IOS_REPO_PATH is only required for sync mode
  if (mode === 'sync' || mode === 'all') {
    if (!process.env.IOS_REPO_PATH) {
      log('Warning: IOS_REPO_PATH not set - release sync will be skipped');
    }
  }

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      log(`ERROR: Missing required environment variable: ${varName}`);
      process.exit(1);
    }
  }

  // Initialize clients
  const asc = new AppStoreConnectAPI(
    process.env.APP_STORE_CONNECT_API_KEY_ID,
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    process.env.APP_STORE_CONNECT_API_KEY_CONTENT
  );

  const github = new GitHubAPI(CONFIG.iosRepoOwner, CONFIG.iosRepoName);
  const git = CONFIG.iosRepoPath ? new GitOperations(CONFIG.iosRepoPath) : null;

  try {
    // Run deploy check
    if (mode === 'deploy' || mode === 'all') {
      await runDeployCheck(asc, github, DRY_RUN);
    }

    // Run release sync
    if (mode === 'sync' || mode === 'all') {
      if (git) {
        await runReleaseSync(asc, git, github, DRY_RUN);
      }
    }

    log('=== Done ===');

  } catch (error) {
    log(`ERROR: ${error.message}`);
    if (error.stack) {
      log(`Stack: ${error.stack.split('\n').slice(1, 4).join('\n')}`);
    }
    process.exit(1);
  }
}

// Run
main();
