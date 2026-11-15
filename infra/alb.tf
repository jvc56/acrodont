# ALB, HTTPS only (port 80 redirects), with a 120-second idle timeout for admin
# uploads. Nginx's keepalive_timeout (docker/nginx.conf.template) must stay
# above idle_timeout, or the ALB reuses connections Nginx has closed and
# answers 502 (EDGE-1; frontend/src/lib/nginx-config.test.ts pins it).
resource "aws_acm_certificate" "site" {
  domain_name = var.domain_name
  # null, not []: AWS reads the names back with the domain's own among them,
  # and an empty list set here could show as a change on every plan.
  subject_alternative_names = var.redirect_www ? ["www.${var.domain_name}"] : null
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records are created out of band (outputs.acm_validation_records).
resource "aws_acm_certificate_validation" "site" {
  certificate_arn = aws_acm_certificate.site.arn
}

resource "aws_lb" "main" {
  name                       = "acrodont"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name        = "acrodont-web"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  # /health includes the catalog indexes being loaded, and the database. ECS
  # replaces a task whose target is unhealthy, so ten misses at 30 s, like
  # the container's own check (ecs.tf): a database restart is ridden out
  # rather than answered by killing a task that has the catalog in memory.
  # acrodont-down still waits its ten minutes either way.
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 10
  }
  # Spent before SIGTERM reaches the old task; the 300 s default made every
  # deploy minutes slower (birdtest f2fda4c).
  deregistration_delay = 15
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# www.<domain> is not the site: both listeners send it to the bare domain,
# path and query kept (redirect_www).
resource "aws_lb_listener_rule" "www" {
  for_each     = var.redirect_www ? { http = aws_lb_listener.http.arn, https = aws_lb_listener.https.arn } : {}
  listener_arn = each.value
  priority     = 1
  action {
    type = "redirect"
    redirect {
      host        = var.domain_name
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  condition {
    host_header {
      values = ["www.${var.domain_name}"]
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.site.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
