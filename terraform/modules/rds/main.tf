resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnet-group"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "${var.project_name}-db-subnet-group"
  }
}

# Aurora Serverless v2 — scales to 0 ACU (auto-pause) when idle
# Wakes automatically on first connection (~30 sec cold start)
resource "aws_rds_cluster" "main" {
  cluster_identifier = "${var.project_name}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "16.4"

  database_name   = var.db_name
  master_username = var.db_username
  master_password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.rds_security_group_id]

  serverlessv2_scaling_configuration {
    min_capacity             = 0     # 0 = auto-pause when idle
    max_capacity             = 1     # max 1 ACU (~$0.12/hr) — enough for light use
    seconds_until_auto_pause = 300   # pause after 5 minutes of no connections
  }

  storage_encrypted            = true
  skip_final_snapshot          = true
  deletion_protection          = false
  performance_insights_enabled = false
  enable_http_endpoint         = true

  tags = {
    Name = "${var.project_name}-aurora"
  }
}

resource "aws_rds_cluster_instance" "main" {
  identifier         = "${var.project_name}-aurora-instance"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  performance_insights_enabled = false

  tags = {
    Name = "${var.project_name}-aurora-instance"
  }
}
