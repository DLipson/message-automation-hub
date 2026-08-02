# GitHub Actions VM Metadata Deploy

This project deploys from GitHub Actions to the Google Cloud VM through Workload Identity Federation and Compute Engine metadata startup scripts. This avoids long-lived Google service account keys, public SSH, IAP SSH, and OS Login for deploys.

Current repo:

```text
DLipson/message-automation-hub
```

Current VM:

```text
project: project-f57c5350-09b6-46d6-957
instance: message-hub-2
zone: us-central1-a
```

Staging (optional):

```text
project: project-f57c5350-09b6-46d6-957
instance: message-hub-staging
zone: us-central1-a
```

## One-Time Google Cloud Setup

Run these commands from a machine where `gcloud` can validate TLS normally. Do not use SSL validation bypass for this setup unless you explicitly accept that risk.

```bash
PROJECT_ID="project-f57c5350-09b6-46d6-957"
ZONE="us-central1-a"
INSTANCE="message-hub-2"
REPO="DLipson/message-automation-hub"
POOL_ID="github-actions"
PROVIDER_ID="message-automation-hub"
SA_ID="github-actions-message-hub"
SA_EMAIL="${SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

# Required APIs.
gcloud services enable \
  compute.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project "$PROJECT_ID"

# Service account used by GitHub Actions.
gcloud iam service-accounts create "$SA_ID" \
  --project "$PROJECT_ID" \
  --display-name "GitHub Actions deploy for message-automation-hub"

# Workload Identity pool and GitHub OIDC provider.
gcloud iam workload-identity-pools create "$POOL_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --workload-identity-pool "$POOL_ID" \
  --display-name "message-automation-hub" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository=='${REPO}' && assertion.ref=='refs/heads/master'"

# Let only this GitHub repo impersonate the deploy service account.
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT_ID" \
  --role "roles/iam.workloadIdentityUser" \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPO}"

# Minimal permissions needed by the metadata/reset deploy workflow.
gcloud iam roles create messageHubGithubDeploy \
  --project "$PROJECT_ID" \
  --title "Message Hub GitHub Deploy" \
  --description "Deploy message hub through VM startup metadata and serial output" \
  --permissions compute.instances.get,compute.instances.getSerialPortOutput,compute.instances.reset,compute.instances.setMetadata \
  --stage GA

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "projects/${PROJECT_ID}/roles/messageHubGithubDeploy"
```

## GitHub Variables

Set repository variables after the Google Cloud setup succeeds:

```bash
gh variable set GCP_PROJECT_ID --repo "$REPO" --body "$PROJECT_ID"
gh variable set GCP_ZONE --repo "$REPO" --body "$ZONE"
gh variable set GCP_INSTANCE --repo "$REPO" --body "$INSTANCE"
gh variable set GCP_SERVICE_ACCOUNT --repo "$REPO" --body "$SA_EMAIL"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$REPO" --body "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
```

No Google service account JSON key is needed.

## Deploy Behavior

`.github/workflows/deploy.yml` runs on pushes to `master` and `stage`, and manual `workflow_dispatch` runs. It:

1. Runs `npm ci`, `npm test`, and `npm run build` on GitHub Actions.
2. Authenticates to Google Cloud through Workload Identity Federation.
3. Writes a one-time startup script to the VM metadata.
4. Resets the VM so the startup script runs as root.
5. Adds and enables a 1 GiB `/swapfile` if missing (prod only).
6. Stops and disables the settings GUI service (prod only).
7. Fetches the pushed commit into `/opt/message-automation-hub`.
8. Runs `npm ci --include=dev --no-audit --no-fund` and `npm run build` on the VM (prod) or `docker compose up -d --build` (stage).
9. Installs the repo's systemd unit so production runs compiled `dist/index.js` (prod only).
10. Clears stale WhatsApp Web Chromium lock files (prod only).
11. Restarts `message-automation-hub` with systemd (prod) or the compose stack (stage).
12. Waits for the serial-console completion marker, then restores the normal lightweight startup script.

The `master` branch targets the prod VM (`GCP_INSTANCE`/`GCP_ZONE`); the `stage` branch targets the staging VM (`STAGING_GCP_INSTANCE`/`STAGING_GCP_ZONE`). Jobs are skipped until their required GitHub variables are set.

## Staging VM (docker compose)

`deploy-stage` in the same workflow deploys the `stage` branch to a separate VM through the same metadata startup-script + reset mechanism, but the remote script runs `docker compose up -d --build` instead of npm/systemd.

### Create the VM

```bash
gcloud compute instances create message-hub-staging \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --machine-type e2-small \
  --boot-disk-size 20GB \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --tags http-server,https-server
```

The deploy script only handles git checkout + `docker compose up`. The VM must have Docker Engine + the Compose plugin installed once, ahead of the first deploy:

```bash
gcloud compute ssh message-hub-staging --project "$PROJECT_ID" --zone "$ZONE" -- \
  'curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER'
```

### Widening OIDC for the stage branch

The provider condition created above allows only `refs/heads/master`. Allow the `stage` branch too (same repo, same service account):

```bash
gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
  --project "$PROJECT_ID" \
  --location global \
  --workload-identity-pool "$POOL_ID" \
  --attribute-mapping "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition "assertion.repository=='${REPO}' && (assertion.ref=='refs/heads/master' || assertion.ref=='refs/heads/stage')"
```

### Staging GitHub variables

```bash
gh variable set STAGING_GCP_ZONE --repo "$REPO" --body "$ZONE"
gh variable set STAGING_GCP_INSTANCE --repo "$REPO" --body "message-hub-staging"
```

`GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT`, and `GCP_WORKLOAD_IDENTITY_PROVIDER` are shared with prod.

### First deploy / secrets

The first `docker compose up` on the VM creates `.env` from `.env.example` and an empty `secrets/secrets.json`. The bot will not fully run until you configure those on the VM:

```bash
gcloud compute ssh message-hub-staging --project "$PROJECT_ID" --zone "$ZONE" -- \
  'cd /opt/message-automation-hub && sudo nano .env'
```

Because staging is a deploy-only smoke test, the workflow does not assert the bot reaches `is-active` (unlike prod, where the deploy fails if `message-automation-hub.service` is not active).
