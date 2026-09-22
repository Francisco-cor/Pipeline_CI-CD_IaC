output "web_acl_arn" {
  description = "ARN of the WAF web ACL associated with the ALB."
  value       = aws_wafv2_web_acl.main.arn
}
