variable "project_name" {
  description = "Project name prefix used in the WAF resource names."
  type        = string
}

variable "environment" {
  description = "Deployment environment used in the WAF resource names."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the regional ALB protected by this WAF."
  type        = string
}

variable "rate_limit" {
  description = "Maximum requests per five minutes per source IP."
  type        = number

  validation {
    condition     = var.rate_limit >= 100
    error_message = "rate_limit must be at least 100 requests per five minutes."
  }
}
