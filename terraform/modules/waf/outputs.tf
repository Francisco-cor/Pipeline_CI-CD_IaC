output "web_acl_arn" {
  description = "ARN of the WAF web ACL associated with the ALB."
  value       = aws_wafv2_web_acl.main.arn
}

output "web_acl_name" {
  description = "Name of the WAF web ACL. Used as the WebACL dimension for AWS/WAFV2 CloudWatch metrics."
  value       = aws_wafv2_web_acl.main.name
}
