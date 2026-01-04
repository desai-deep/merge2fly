import { execSync } from 'child_process';

export class GitHubAPI {
  constructor(repoOwner, repoName) {
    this.repoOwner = repoOwner;
    this.repoName = repoName;
  }

  findPRFromCommit(commitSha) {
    try {
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

        const match = commitMsg.match(/\(#(\d+)\)/);
        if (match) return match[1];

        const mergeMatch = commitMsg.match(/pull request #(\d+)/);
        if (mergeMatch) return mergeMatch[1];
      } catch (e2) {
        // Ignore
      }
    }

    return null;
  }

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

  extractReleaseNotes(prBody, prTitle) {
    if (prBody) {
      const match = prBody.match(/^##?\s*Release Notes\s*\n([\s\S]*?)(?=\n#|$)/im);
      if (match) {
        const notes = match[1].trim();
        if (notes) return notes;
      }
    }

    return prTitle || 'Bug fixes and improvements';
  }

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
