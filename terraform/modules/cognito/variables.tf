variable "project_name" {
  type = string
}

variable "invite_only" {
  description = "true = invite-only; false = self-registration allowed"
  type        = bool
  default     = false
}
