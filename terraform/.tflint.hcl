# SPDX-License-Identifier: MIT
# .tflint.hcl — tflint config for ERP Pipeline (Fase 6.4)
# Plugin AWS oficial + reglas básicas. Core rules vienen con tflint.
# Ejecutar: tflint --init && tflint --recursive --format compact

config {
  call_module_type = "local"
  force            = false
}

plugin "aws" {
  enabled = true
  version = "0.38.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

# Reglas adicionales (terraform core)
rule "terraform_naming_convention" {
  enabled = true
  format  = "snake_case"
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

rule "terraform_typed_variables" {
  enabled = true
}

rule "terraform_unused_declarations" {
  enabled = true
}
