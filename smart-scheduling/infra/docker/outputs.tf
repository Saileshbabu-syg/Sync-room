# Outputs: values printed after `apply`, and readable by other configs/modules.
# Later, the Azure stage will output a DATABASE_URL in the same way.

output "database_url" {
  description = "Connection string for the app's DATABASE_URL"
  value       = "postgresql://${var.db_user}:${var.db_password}@localhost:${var.db_port}/${var.db_name}"
  sensitive   = true # view with: terraform output -raw database_url
}
