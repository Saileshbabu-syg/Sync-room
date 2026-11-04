# Input variables: the "parameters" of this configuration.
# A variable with a `default` is optional; without one, Terraform requires it.

variable "project_name" {
  description = "Prefix for resource names"
  type        = string
  default     = "smart-scheduling"
}

variable "db_user" {
  type    = string
  default = "postgres"
}

variable "db_name" {
  type    = string
  default = "smart_db"
}

variable "db_port" {
  description = "Host port mapped to Postgres"
  type        = number
  default     = 5433
}

# No default: you must supply it (see terraform.tfvars.example).
# `sensitive = true` hides the value in plan/apply output.
# (It is still stored in plain text in the state file - more on that later.)
variable "db_password" {
  description = "Postgres password"
  type        = string
  sensitive   = true
}
