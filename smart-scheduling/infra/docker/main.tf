# --- 1. terraform block: settings for Terraform itself ---------------------
# required_providers tells Terraform which plugins to download on `init`.
# A "provider" is a plugin that knows how to talk to one platform's API
# (here: the local Docker engine). Version constraints keep results repeatable.
terraform {
  required_version = ">= 1.6"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

# --- 2. provider block: how to connect --------------------------------------
# On Windows, Docker Desktop listens on a named pipe.
provider "docker" {
  host = "npipe:////.//pipe//docker_engine"
}

# --- 3. resources: the things we want to exist ------------------------------
# Syntax: resource "<TYPE>" "<LOCAL NAME>" { ... }
# The local name is only used to refer to it elsewhere in this code.

# Image: equivalent to `docker pull postgres:16-alpine`.
resource "docker_image" "postgres" {
  name         = "postgres:16-alpine"
  keep_locally = true # don't delete the image on `destroy`
}

# Volume: equivalent to the `smart_db_data` volume in docker-compose.yml.
# It keeps data across container re-creations.
resource "docker_volume" "db_data" {
  name = "${var.project_name}_db_data"
}

# Container: equivalent to the `db` service in docker-compose.yml.
resource "docker_container" "db" {
  name    = "${var.project_name}-db"
  # Referencing docker_image.postgres.image_id makes Terraform build a
  # dependency graph: the image is created first, then this container.
  image   = docker_image.postgres.image_id
  restart = "unless-stopped"

  env = [
    "POSTGRES_USER=${var.db_user}",
    "POSTGRES_PASSWORD=${var.db_password}", # comes from a variable, not hardcoded
    "POSTGRES_DB=${var.db_name}",
  ]

  ports {
    internal = 5432
    external = var.db_port
  }

  volumes {
    volume_name    = docker_volume.db_data.name
    container_path = "/var/lib/postgresql/data"
  }
}
