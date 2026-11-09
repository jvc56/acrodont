# Immutable tags: a tag names one image forever, which is what makes
# scripts/rollback.sh safe. The backend repository holds <tag> and <tag>-ops.
resource "aws_ecr_repository" "backend" {
  name                 = "wordfall-backend"
  image_tag_mutability = "IMMUTABLE"
}

resource "aws_ecr_repository" "frontend" {
  name                 = "wordfall-frontend"
  image_tag_mutability = "IMMUTABLE"
}

# Old releases accumulate storage charges; forty images is twenty releases of
# backend and ops, months of rollback targets.
resource "aws_ecr_lifecycle_policy" "keep_recent" {
  for_each   = { backend = aws_ecr_repository.backend.name, frontend = aws_ecr_repository.frontend.name }
  repository = each.value
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 40 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 40 }
      action       = { type = "expire" }
    }]
  })
}
