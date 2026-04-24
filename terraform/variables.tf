variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-2"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "tech-enquiry"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "prod"
}

variable "db_name" {
  description = "PostgreSQL database name"
  type        = string
  default     = "enquiries"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  default     = "dbadmin"
}

variable "db_password" {
  description = "PostgreSQL master password"
  type        = string
  sensitive   = true
  default     = "placeholder"
}

variable "bedrock_model_id" {
  description = "Amazon Bedrock model ID"
  type        = string
  default     = "anthropic.claude-3-5-sonnet-20241022-v2:0"
}

variable "invite_only" {
  description = "true = invite-only (admin creates users); false = self-registration allowed"
  type        = bool
  default     = false
}

variable "sharepoint_tenant_id" {
  description = "Azure AD Tenant ID for SharePoint access"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sharepoint_client_id" {
  description = "Azure App Registration Client ID for SharePoint access"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sharepoint_client_secret" {
  description = "Azure App Registration Client Secret for SharePoint access"
  type        = string
  sensitive   = true
  default     = ""
}
