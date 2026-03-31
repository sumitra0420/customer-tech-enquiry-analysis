output "endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "port" {
  value = aws_rds_cluster.main.port
}

output "cluster_identifier" {
  value = aws_rds_cluster.main.cluster_identifier
}
