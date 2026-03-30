# -----------------------------------------------------------------------------
# cicd.tf — GitHub Actions OIDC integration
#
# Instead of storing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in GitHub
# secrets (long-lived, hard to rotate, risky if leaked), we configure an
# OpenID Connect trust relationship. GitHub mints a short-lived JWT for each
# workflow run; AWS verifies it and issues a temporary role session.
#
# Result: zero credentials stored anywhere. See ADR-002 for the full rationale.
#
# Setup after terraform apply:
#   1. Run: terraform output github_actions_role_arn
#   2. Add that value as the AWS_ROLE_ARN secret in GitHub repo settings.
# -----------------------------------------------------------------------------

# Fetch GitHub's OIDC certificate to get the thumbprint AWS requires.
# This is a data source, not a resource — it makes no AWS API calls.
data "tls_certificate" "github_actions" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

# Register GitHub as a trusted OIDC identity provider in this AWS account.
# Only needs to exist once per account; idempotent if re-applied.
resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github_actions.certificates[0].sha1_fingerprint]
}

# Trust policy: restrict which GitHub repos and ref patterns can assume this role.
# The sub claim format is: repo:<owner>/<repo>:ref:refs/heads/<branch>
# Using a wildcard (*) allows any branch/tag/PR — tighten to :ref:refs/heads/main
# in production for strict branch protection.
data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    # aud must be sts.amazonaws.com (set automatically by aws-actions/configure-aws-credentials)
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Scope to this specific GitHub repository.
    # Two subjects are allowed:
    #   - push to main   → build + deploy jobs
    #   - pull_request   → terraform plan job (read-only, no deploy)
    # Any other branch or actor cannot assume this role.
    # var.github_repo format: "owner/repo-name"
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.project_name}-${var.environment}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
  description        = "Assumed by GitHub Actions via OIDC for CI/CD - no long-lived keys"
}

# Minimal permissions for the CI/CD pipeline:
#   ECR: authenticate + push images
#   ECS: describe + register task definitions + update service
#   IAM PassRole: required to register task defs that reference IAM roles
data "aws_iam_policy_document" "github_actions_permissions" {
  # GetAuthorizationToken is not resource-scoped — must use wildcard
  statement {
    sid       = "ECRAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Restrict image push to this project's repositories only
  statement {
    sid = "ECRPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
    ]
    resources = [
      "arn:aws:ecr:${var.aws_region}:*:repository/${var.project_name}-*",
    ]
  }

  # RegisterTaskDefinition and DescribeTaskDefinition do not support resource-level
  # permissions in AWS IAM — they must remain on "*".
  statement {
    sid = "ECSTaskDef"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }

  # Service and cluster actions support resource-level permissions — scope to
  # this project's cluster and service only so the role cannot touch other ECS
  # workloads in the same account.
  statement {
    sid = "ECSServiceDeploy"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = [
      "arn:aws:ecs:${var.aws_region}:*:service/${var.project_name}-${var.environment}-cluster/${var.project_name}-${var.environment}-service",
    ]
  }

  # ListTasks is scoped to the cluster (correct resource type for this action).
  statement {
    sid     = "ECSListTasks"
    actions = ["ecs:ListTasks"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:*:cluster/${var.project_name}-${var.environment}-cluster",
    ]
  }

  # DescribeTasks requires a task ARN, not a cluster ARN.
  # Previously both actions shared the cluster ARN resource, which caused
  # AccessDenied for DescribeTasks at runtime.
  statement {
    sid     = "ECSDescribeTasks"
    actions = ["ecs:DescribeTasks"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:*:task/${var.project_name}-${var.environment}-cluster/*",
    ]
  }

  # PassRole is required when registering a task definition that references IAM roles.
  # Scoped to roles in this project to prevent privilege escalation.
  statement {
    sid       = "PassRole"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::*:role/${var.project_name}-${var.environment}-*"]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "github-actions-cicd"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions_permissions.json
}

output "github_actions_role_arn" {
  description = "Add this value as the AWS_ROLE_ARN secret in GitHub repository settings."
  value       = aws_iam_role.github_actions.arn
}
