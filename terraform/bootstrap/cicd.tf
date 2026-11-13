# -----------------------------------------------------------------------------
# cicd.tf — GitHub Actions OIDC integration (bootstrap stack)
#
# This lives in its own Terraform root on purpose. The nightly teardown runs
# `terraform destroy` against ../, and when this file lived there the destroy
# removed the IAM role that every workflow needs to authenticate: after the
# first destroy, teardown, deploy and the trusted plan could never assume the
# role again. Keeping the identity here means app infra can be destroyed
# without losing CI credentials.
#
# Instead of storing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in GitHub
# secrets (long-lived, hard to rotate, risky if leaked), we configure an
# OpenID Connect trust relationship. GitHub mints a short-lived JWT for each
# workflow run; AWS verifies it and issues a temporary role session.
#
# Result: zero credentials stored anywhere. See ADR-002 for the full rationale.
#
# Usage (one-time, per AWS account):
#   cd terraform/bootstrap
#   terraform init -backend-config=../environments/backend-bootstrap-dev.hcl
#   terraform apply
#   terraform output github_actions_role_arn
# Then store that value as the AWS_ROLE_ARN repository secret.
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

  # This provider is shared by every workflow. Replacing it would break all
  # GitHub Actions authentication until the role trust is recreated.
  lifecycle {
    prevent_destroy = true
  }
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

    # Scope to this specific GitHub repository's protected main branch.
    # Pull requests, including those opened from forks, never receive AWS
    # credentials. Terraform PR checks therefore run without backend access.
    #
    # Jobs that declare `environment:` do NOT get a `ref:refs/heads/main`
    # subject; GitHub mints `repo:<owner>/<repo>:environment:<name>` instead.
    # The trusted plan and the teardown run in such environments, so those
    # subjects must be listed explicitly (no wildcard, failing closed).
    # var.github_repo format: "owner/repo-name"
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:environment:terraform-dev",
        "repo:${var.github_repo}:environment:terraform-staging",
        "repo:${var.github_repo}:environment:terraform-prod",
        "repo:${var.github_repo}:environment:destroy",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "${var.project_name}-${var.environment}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
  description        = "Assumed by GitHub Actions via OIDC for CI/CD - no long-lived keys"

  # Losing this role locks every workflow out of AWS (the failure that
  # motivated splitting bootstrap from the app stack). Require an explicit
  # manual step to remove it.
  lifecycle {
    prevent_destroy = true
  }
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

  # The trusted Terraform plan workflow needs to read remote state and acquire
  # the DynamoDB lock. Keep the bucket/table scoped to this environment.
  statement {
    sid = "TerraformBackend"
    actions = [
      "s3:GetBucketVersioning",
      "s3:GetEncryptionConfiguration",
      "s3:ListBucket",
    ]
    resources = ["arn:aws:s3:::${var.project_name}-tfstate-${var.environment}"]
  }

  statement {
    sid = "TerraformStateObjects"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["arn:aws:s3:::${var.project_name}-tfstate-${var.environment}/terraform.tfstate"]
  }

  statement {
    sid = "TerraformStateLock"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = ["arn:aws:dynamodb:${var.aws_region}:*:table/${var.project_name}-tfstate-lock"]
  }

  # Terraform refreshes managed resources during a trusted plan. These are
  # read-only APIs; deploy mutations remain limited to the statements above.
  statement {
    sid = "TerraformReadOnly"
    actions = [
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "cloudformation:DescribeStacks",
      "cloudwatch:DescribeAlarms",
      "dynamodb:DescribeTable",
      "ecr:DescribeRepositories",
      "ecr:ListTagsForResource",
      "ec2:Describe*",
      "ecs:Describe*",
      "ecs:List*",
      "elasticache:Describe*",
      "iam:GetOpenIDConnectProvider",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "logs:Describe*",
      "rds:Describe*",
      "route53:ListHostedZonesByName",
      "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "servicediscovery:Get*",
      "servicediscovery:List*",
      "wafv2:Get*",
      "wafv2:List*",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "github-actions-cicd"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions_permissions.json

  lifecycle {
    prevent_destroy = true
  }
}

output "github_actions_role_arn" {
  description = "Add this value as the AWS_ROLE_ARN secret in GitHub repository settings."
  value       = aws_iam_role.github_actions.arn
}
