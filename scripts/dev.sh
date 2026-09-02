#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/dev.sh — helper para DX local (Fase 2)
# Uso: ./scripts/dev.sh [up|down|logs|ps|nuke|help]
# Existe para quien prefiere script vs Makefile

set -euo pipefail

CMD="${1:-help}"

case "$CMD" in
  up)
    echo "=== docker compose up --build (con hot-reload) ==="
    docker compose up --build
    ;;
  up-d|detached)
    docker compose up --build -d
    docker compose ps
    echo ""
    echo "API: http://localhost:80/api/productos"
    echo "Health: curl http://localhost:80/health"
    ;;
  prod)
    echo "=== prod (sin override) ==="
    docker compose -f docker-compose.yml up --build -d
    docker compose -f docker-compose.yml ps
    ;;
  down)
    docker compose down --remove-orphans
    ;;
  logs)
    docker compose logs -f
    ;;
  ps)
    docker compose ps
    ;;
  nuke)
    echo "=== nuke: borra volumen pgdata ==="
    docker compose down -v --remove-orphans
    docker volume prune -f
    ;;
  help|*)
    echo "Uso: $0 [up|up-d|prod|down|logs|ps|nuke|help]"
    echo ""
    echo "  up        compose up con hot-reload (override)"
    echo "  up-d      detached + ps"
    echo "  prod      sin override (prod-like)"
    echo "  down      compose down"
    echo "  logs      logs -f"
    echo "  ps        compose ps"
    echo "  nuke      down -v (borra DB)"
    echo ""
    echo "Alternativa: make <target> (ver Makefile:1)"
    ;;
esac
