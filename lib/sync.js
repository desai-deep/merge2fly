import { CONFIG, log } from './config.js';

export async function runReleaseSync(asc, git, github, DRY_RUN) {
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
