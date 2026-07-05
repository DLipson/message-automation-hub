# GitHub Actions IAP Deploy

This project can deploy from GitHub Actions to the private Google Cloud VM through Workload Identity Federation and IAP. This avoids long-lived Google service account keys and avoids exposing SSH publicly.

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
  iap.googleapis.com \
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

# Permissions needed to SSH privately through IAP and administer the VM over OS Login.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "roles/iap.tunnelResourceAccessor"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "roles/compute.viewer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "roles/compute.osAdminLogin"

# Recommended for service-account SSH through gcloud compute ssh.
# Review existing SSH access before enabling OS Login if you rely on metadata SSH keys.
gcloud compute instances add-metadata "$INSTANCE" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --metadata enable-oslogin=TRUE
```

If the VM does not already allow IAP SSH, add a firewall rule for TCP 22 from Google's IAP range to the VM tag:

```bash
gcloud compute firewall-rules create allow-iap-ssh-message-hub \
  --project "$PROJECT_ID" \
  --direction INGRESS \
  --action ALLOW \
  --rules tcp:22 \
  --source-ranges 35.235.240.0/20 \
  --target-tags message-hub-iap
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

## Test IAP SSH

Before relying on automatic deploys, test the same path locally or from a temporary GitHub workflow:

```bash
gcloud compute ssh "$INSTANCE" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --tunnel-through-iap \
  --command 'hostname && systemctl is-active message-automation-hub'
```

## Deploy Behavior

`.github/workflows/deploy.yml` runs on pushes to `master` and manual `workflow_dispatch` runs. It:

1. Runs `npm ci`, `npm test`, and `npm run build` on GitHub Actions.
2. Authenticates to Google Cloud through Workload Identity Federation.
3. SSHes to the VM through IAP.
4. Initializes `/opt/message-automation-hub` as a Git checkout if needed.
5. Fetches and resets to `origin/master`.
6. Runs `npm ci --include=dev --no-audit --no-fund` and `npm run build`.
7. Clears stale WhatsApp Web Chromium lock files.
8. Restarts `message-automation-hub` with systemd.

The deploy job is skipped until all required GitHub variables are set.