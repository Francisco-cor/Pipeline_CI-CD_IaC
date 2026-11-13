# SPDX-License-Identifier: MIT
# cicd.tf — moved to ./bootstrap/cicd.tf
#
# The GitHub Actions OIDC provider, IAM role and inline policy must survive the
# nightly `terraform destroy` of this stack, otherwise no workflow can
# authenticate afterwards. They now live in the separate bootstrap stack.
# See ./removed.tf for the one-time state migration and
# docs/runbooks/bootstrap.md for the recovery steps.
