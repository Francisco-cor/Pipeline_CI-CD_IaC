# SPDX-License-Identifier: MIT
# removed.tf — one-time migration of the CI identity to ./bootstrap.
#
# `destroy = false` tells Terraform to forget these resources without deleting
# them from AWS. Apply this stack once, then import them into the bootstrap
# stack (commands in docs/runbooks/bootstrap.md). Without this block a plan
# would propose destroying the role on the next apply.

removed {
  from = aws_iam_openid_connect_provider.github_actions

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.github_actions

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role_policy.github_actions

  lifecycle {
    destroy = false
  }
}
