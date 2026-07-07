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

# Permissions needed by the metadata/reset deploy workflow.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "roles/compute.instanceAdmin.v1"
```

`roles/compute.instanceAdmin.v1` is intentionally broader than the workflow strictly needs. For tighter production IAM, replace it with a custom role containing these permissions on `message-hub-2`:

```text
compute.instances.get
compute.instances.getSerialPortOutput
compute.instances.reset
compute.instances.setMetadata
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

`.github/workflows/deploy.yml` runs on pushes to `master` and manual `workflow_dispatch` runs. It:

1. Runs `npm ci`, `npm test`, and `npm run build` on GitHub Actions.
2. Authenticates to Google Cloud through Workload Identity Federation.
3. Writes a one-time startup script to the VM metadata.
4. Resets the VM so the startup script runs as root.
5. Adds and enables a 1 GiB `/swapfile` if missing.
6. Stops and disables the settings GUI service.
7. Fetches the pushed commit into `/opt/message-automation-hub`.
8. Runs `npm ci --include=dev --no-audit --no-fund` and `npm run build` on the VM.
9. Installs the repo's systemd unit so production runs compiled `dist/index.js`.
10. Clears stale WhatsApp Web Chromium lock files.
11. Restarts `message-automation-hub` with systemd.
12. Waits for the serial-console completion marker, then restores the normal lightweight startup script.

The deploy job is skipped until all required GitHub variables are set.
