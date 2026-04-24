resource "aws_secretsmanager_secret" "sharepoint_credentials" {
  name                    = "${var.project_name}/sharepoint-credentials"
  description             = "SharePoint API credentials for automated file download"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "sharepoint_credentials" {
  secret_id = aws_secretsmanager_secret.sharepoint_credentials.id
  secret_string = jsonencode({
    TENANT_ID     = var.sharepoint_tenant_id
    CLIENT_ID     = var.sharepoint_client_id
    CLIENT_SECRET = var.sharepoint_client_secret
  })
}
