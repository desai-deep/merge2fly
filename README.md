# merge2fly

Automated iOS App Store deployment script. Monitors TestFlight builds from Xcode Cloud and submits them for App Store review.

## Features

- Monitors TestFlight for new builds from specific Xcode Cloud workflows
- Automatically submits builds to App Store review
- Extracts release notes from merged GitHub PRs
- Comments on PRs when builds are submitted or cancelled
- Handles rejected versions by resubmitting
- 10x faster than Fastlane-based solutions (~8s vs ~60s)

## How It Works

```
Xcode Cloud                          Your VPS
┌─────────────────┐                  ┌─────────────────────────┐
│ Build Workflow  │                  │  merge2fly (cron)       │
│ "Publish to     │──► TestFlight ──►│                         │
│  App Store"     │                  │  1. Check new builds    │
└─────────────────┘                  │  2. Find merged PR      │
                                     │  3. Extract release notes│
                                     │  4. Submit for review   │
                                     │  5. Comment on PR       │
                                     └─────────────────────────┘
```

## Setup

### 1. Install

```bash
git clone https://github.com/desai-deep/merge2fly.git
cd merge2fly
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### 3. Run

```bash
# Dry run (no changes)
DRY_RUN=true node ios-deploy.js

# Normal run
node ios-deploy.js
```

### 4. Schedule (cron)

```bash
# Run every 5 minutes
*/5 * * * * cd /path/to/merge2fly && node ios-deploy.js >> logs/cron.log 2>&1
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect Issuer ID |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | API private key (base64 encoded) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_BUNDLE_ID` | `com.deepdesai.runningorder` | Your app's bundle identifier |
| `APP_NAME` | `Running Order` | App name (for logging) |
| `GITHUB_REPO_OWNER` | `desai-deep` | GitHub org/user |
| `GITHUB_REPO_NAME` | `runningorder-ios` | GitHub repo name |
| `XCODE_WORKFLOW_NAME` | `Publish to App Store` | Xcode Cloud workflow to monitor |
| `GH_TOKEN` | - | GitHub token for PR comments |
| `DRY_RUN` | `false` | Run without making changes |

## Requirements

- Node.js 18+
- `gh` CLI (for GitHub PR operations)
- App Store Connect API key with App Manager permissions

## How It Filters Builds

The script only processes builds from the specified Xcode Cloud workflow (default: "Publish to App Store"). Other workflows like "Public Beta" or "UAT" are skipped - they're for TestFlight distribution only, not App Store submission.

## License

MIT
