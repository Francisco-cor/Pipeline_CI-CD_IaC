# ADR-002: OIDC for GitHub Actions instead of long-lived IAM access keys

**Status:** Accepted
**Date:** 2026-03-20
**Context:** CI/CD pipeline authentication to AWS (Week 3)

---

## Context

The GitHub Actions pipeline needs to push Docker images to ECR and deploy to ECS. This requires AWS credentials in the runner environment.

The naive approach is creating an IAM user, generating an `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair, and storing both as encrypted GitHub repository secrets.

---

## Decision

Use **OpenID Connect (OIDC)** to federate GitHub Actions as a trusted identity provider in AWS IAM.

Each workflow run receives a short-lived JWT from GitHub's OIDC endpoint. The pipeline exchanges this JWT for temporary AWS credentials via `sts:AssumeRoleWithWebIdentity`. No static keys exist anywhere.

Terraform resources in `cicd.tf`:
- `aws_iam_openid_connect_provider.github_actions` — registers GitHub as a trusted IdP
- `aws_iam_role.github_actions` — trust policy scoped to this specific repository
- Inline policy with least-privilege permissions (ECR push + ECS deploy only)

GitHub Actions configuration in `pipeline.yml`:
```yaml
permissions:
  id-token: write   # allows the runner to request an OIDC token
  contents: read

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: us-east-2
```

`AWS_ROLE_ARN` is the only secret stored in GitHub — it is a role ARN, not a credential.

---

## Alternatives considered

### Long-lived IAM access keys (rejected)

| Risk | Impact |
|------|--------|
| Keys never expire by default | If leaked, attacker has permanent access until manual rotation |
| Hard to audit usage | CloudTrail entries use the IAM user, not the specific developer or workflow |
| Secret sprawl | Keys copied to staging, dev machines, CI — each is an attack surface |
| Rotation friction | Manual process, easy to defer, often skipped |

### VPC-peered self-hosted runner (rejected)

A runner inside the VPC could use an instance profile instead of OIDC. Operationally heavier: the runner EC2 instance must be maintained, patched, and monitored. Overkill for a project where `ubuntu-latest` covers all requirements.

---

## Consequences

**Benefits:**
- Zero long-lived credentials stored anywhere (GitHub, developer machines, CI config)
- Credentials are time-bounded: they expire after the workflow run
- Scope is explicit in the trust policy — only `repo:owner/Pipeline_CI-CD_IaC:*` can assume the role
- CloudTrail entries show the GitHub workflow run ID, not an anonymous IAM user
- No rotation process to maintain

**Trade-offs:**
- One extra setup step after `terraform apply`: copy the role ARN output to GitHub secrets
- OIDC trust is per-account — if the same pattern is needed in a second account, `cicd.tf` must be applied there too

---

## Setup

```bash
cd terraform
terraform apply -var="github_repo=owner/Pipeline_CI-CD_IaC"

# Copy the output value to GitHub:
# Settings → Secrets and variables → Actions → New repository secret
# Name: AWS_ROLE_ARN
# Value: <paste the github_actions_role_arn output>
terraform output github_actions_role_arn
```
