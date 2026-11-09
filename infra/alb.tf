# ALB, HTTPS only (port 80 redirects), with a 120-second idle timeout for admin
# uploads. Nginx's keepalive_timeout (docker/nginx.conf.template) must stay
# above idle_timeout, or the ALB reuses connections Nginx has closed and
# answers 502 (EDGE-1; frontend/src/lib/nginx-config.test.ts pins it).
resource "aws_acm_certificate" "site" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records are created out of band (outputs.acm_validation_records).
resource "aws_acm_certificate_validation" "site" {
  certificate_arn = aws_acm_certificate.site.arn
}

resource "aws_lb" "main" {
  name                       = "wordfall"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name        = "wordfall-web"
  port        = 80
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  # /health includes the catalog indexes being loaded.
  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
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
