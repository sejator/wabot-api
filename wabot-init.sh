#!/bin/bash
set -e

# ==========================================================
# Setup Docker network + PostgreSQL + Redis + .env
# ==========================================================

NETWORK_NAME="wabot_network"
CURRENT_DIR=$(pwd)
BACKUP_DIR="/etc/docker-config-backup"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# ==========================================================
# Deteksi OS
# ==========================================================
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_NAME=$ID
  OS_CODENAME=${UBUNTU_CODENAME:-$VERSION_CODENAME}
else
  echo "Tidak dapat mendeteksi OS. Pastikan file /etc/os-release ada."
  exit 1
fi

echo "Mendeteksi sistem operasi: $PRETTY_NAME"

# ==========================================================
# Fungsi install dependency
# ==========================================================
install_if_missing() {
  local pkg_name="$1"
  local pkg_install="$2"

  # --------------------------------------
  # Instalasi Docker
  # --------------------------------------
  if [ "$pkg_name" = "docker" ]; then
    if ! command -v docker &> /dev/null; then
      echo "Docker belum terinstal. Menginstal Docker..."

      sudo apt-get update -qq
      sudo apt-get install -y ca-certificates curl gnupg lsb-release

      sudo install -m 0755 -d /etc/apt/keyrings

      # menentukan repo Docker berdasarkan OS
      if [[ "$OS_NAME" == "ubuntu" ]]; then
        DOCKER_URL="https://download.docker.com/linux/ubuntu"
      elif [[ "$OS_NAME" == "debian" ]]; then
        DOCKER_URL="https://download.docker.com/linux/debian"
      else
        echo "OS $OS_NAME belum didukung otomatis untuk instalasi Docker."
        exit 1
      fi

      sudo curl -fsSL "${DOCKER_URL}/gpg" -o /etc/apt/keyrings/docker.asc
      sudo chmod a+r /etc/apt/keyrings/docker.asc

      echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] ${DOCKER_URL} ${OS_CODENAME} stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

      sudo apt-get update -qq
      sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

      sudo usermod -aG docker "$USER"
      sudo systemctl enable docker
      sudo systemctl restart docker
      echo "Docker berhasil diinstal dan user '$USER' ditambahkan ke grup docker."
      echo "Silakan logout/login ulang agar group berlaku."
    else
      echo "Docker sudah terinstal."
    fi
    return
  fi

  # --------------------------------------
  # Instalasi (PostgreSQL, Redis, dsb)
  # --------------------------------------
  if ! command -v "$pkg_name" &> /dev/null; then
    echo "Menginstal $pkg_name..."
    sudo apt-get update -qq
    sudo apt-get install -y $pkg_install
    echo "$pkg_name berhasil diinstal."
  else
    echo "$pkg_name sudah terinstal."
  fi
}

# ==========================================================
# Jalankan instalasi dependency
# ==========================================================
install_if_missing docker
install_if_missing psql "postgresql postgresql-contrib"
install_if_missing redis-server "redis"
install_if_missing openssl "openssl"

# ==========================================================
# Dapatkan versi PostgreSQL & lokasi konfigurasi
# ==========================================================
PG_VERSION=$(psql -V 2>/dev/null | awk '{print $3}' | cut -d. -f1)

if [ -z "$PG_VERSION" ]; then
  echo "PostgreSQL tidak ditemukan!"
  exit 1
fi

PG_CONF_PATH="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"
PG_HBA_PATH="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
REDIS_CONF_PATH="/etc/redis/redis.conf"

echo "PostgreSQL versi ${PG_VERSION} terdeteksi."

# ==========================================================
# Buat Docker network jika belum ada
# ==========================================================
if ! docker network ls | grep -q "${NETWORK_NAME}"; then
  docker network create --driver bridge "${NETWORK_NAME}"
  echo "Network '${NETWORK_NAME}' berhasil dibuat."
else
  echo "Network '${NETWORK_NAME}' sudah ada."
fi

SUBNET=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Subnet}}')
GATEWAY_IP=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Gateway}}')

sudo mkdir -p "${BACKUP_DIR}"

# ==========================================================
# Backup & Konfigurasi PostgreSQL
# ==========================================================
if [ -f "${PG_CONF_PATH}" ]; then
  echo "Mengonfigurasi PostgreSQL..."
  sudo cp "${PG_CONF_PATH}" "${BACKUP_DIR}/postgresql.conf.bak_${TIMESTAMP}"
  sudo cp "${PG_HBA_PATH}" "${BACKUP_DIR}/pg_hba.conf.bak_${TIMESTAMP}"

  sudo sed -i "s|^#*listen_addresses.*|listen_addresses = '127.0.0.1,${GATEWAY_IP}'|" "${PG_CONF_PATH}"

  if [ -n "$SUBNET" ] && ! grep -q "${SUBNET}" "${PG_HBA_PATH}"; then
    echo "host    all             all             ${SUBNET}           md5" | sudo tee -a "${PG_HBA_PATH}" > /dev/null
  fi

  sudo systemctl restart postgresql
  echo "PostgreSQL dikonfigurasi dan direstart."
else
  echo "File konfigurasi PostgreSQL tidak ditemukan."
fi

# ==========================================================
# Konfigurasi PostgreSQL User & Database
# ==========================================================
echo ""
echo "=== Konfigurasi PostgreSQL User & Database ==="
echo ""

read -p "Apakah Anda ingin membuat database PostgreSQL baru sekarang? (y/n): " CONFIRM_CREATE

if [[ "$CONFIRM_CREATE" =~ ^[Yy]$ ]]; then
  echo ""
  read -p "Masukkan nama database baru [default: wabot_api]: " DB_NAME
  DB_NAME=${DB_NAME:-wabot_api}

  read -p "Masukkan nama user PostgreSQL baru [default: wabot_user]: " DB_USER
  DB_USER=${DB_USER:-wabot_user}

  read -s -p "Masukkan password untuk user PostgreSQL (kosong = generate otomatis): " DB_PASS
  echo ""
  if [ -z "$DB_PASS" ]; then
    DB_PASS=$(openssl rand -base64 16 | tr -dc 'A-Za-z0-9_')
    echo "Password otomatis dibuat: $DB_PASS"
  fi

  echo ""
  echo "Membuat user dan database PostgreSQL..."

  # Buat user jika belum ada
  sudo -u postgres psql -q <<EOF
DO
\$do\$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
      CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
   END IF;
END
\$do\$;
EOF

  # Buat database jika belum ada
  DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")
  if [ "$DB_EXISTS" != "1" ]; then
    echo "Membuat database ${DB_NAME}..."
    sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
    sudo -u postgres psql -q -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
    echo "Database ${DB_NAME} berhasil dibuat."
  else
    echo "Database ${DB_NAME} sudah ada, dilewati."
  fi

  echo "User & database PostgreSQL berhasil dibuat."
else
  echo "Pembuatan user & database PostgreSQL dilewati."
  DB_NAME="wabot_api"
  DB_USER="wabot_user"
  DB_PASS="password_default"
fi

# ==========================================================
# Backup & Konfigurasi Redis
# ==========================================================
REDIS_PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9_')

if [ -f "${REDIS_CONF_PATH}" ]; then
  echo "Mengonfigurasi Redis..."
  sudo cp "${REDIS_CONF_PATH}" "${BACKUP_DIR}/redis.conf.bak_${TIMESTAMP}"

  sudo sed -i "s|^#*bind .*|bind 127.0.0.1 ${GATEWAY_IP}|" "${REDIS_CONF_PATH}"
  if grep -q "^requirepass" "${REDIS_CONF_PATH}"; then
    sudo sed -i "s|^requirepass .*|requirepass ${REDIS_PASS}|" "${REDIS_CONF_PATH}"
  else
    echo "requirepass ${REDIS_PASS}" | sudo tee -a "${REDIS_CONF_PATH}" > /dev/null
  fi

  sudo systemctl restart redis
  echo "Redis dikonfigurasi dan direstart."
fi

# ==========================================================
# Setup file .env
# ==========================================================
echo ""
echo "Menyiapkan file .env..."

USER_NAME=$(whoami)

if [ -f ".env" ]; then
  cp .env ".env.backup_${TIMESTAMP}"
  echo "Backup .env dibuat: .env.backup_${TIMESTAMP}"
elif [ -f ".env.example" ]; then
  cp .env.example .env
else
  touch .env
fi

sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env || echo "NODE_ENV=production" >> .env
sed -i "s|^DATABASE_HOST=.*|DATABASE_HOST=${GATEWAY_IP}|" .env || echo "DATABASE_HOST=${GATEWAY_IP}" >> .env
sed -i "s|^DATABASE_PORT=.*|DATABASE_PORT=5432|" .env || echo "DATABASE_PORT=5432" >> .env
sed -i "s|^DATABASE_USER=.*|DATABASE_USER=${DB_USER}|" .env || echo "DATABASE_USER=${DB_USER}" >> .env
sed -i "s|^DATABASE_PASSWORD=.*|DATABASE_PASSWORD=${DB_PASS}|" .env || echo "DATABASE_PASSWORD=${DB_PASS}" >> .env
sed -i "s|^DATABASE_NAME=.*|DATABASE_NAME=${DB_NAME}|" .env || echo "DATABASE_NAME=${DB_NAME}" >> .env
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@${GATEWAY_IP}:5432/${DB_NAME}?schema=public|" .env || echo "DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@${GATEWAY_IP}:5432/${DB_NAME}?schema=public" >> .env

sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|" .env || echo "REDIS_PASSWORD=${REDIS_PASS}" >> .env
sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASS}@${GATEWAY_IP}:6379|" .env || echo "REDIS_URL=redis://:${REDIS_PASS}@${GATEWAY_IP}:6379" >> .env
sed -i "s|^REDIS_PORT=.*|REDIS_PORT=6379|" .env || echo "REDIS_PORT=6379" >> .env

sed -i "s|^WWEBJS_SESSION_PATH=.*|WWEBJS_SESSION_PATH=${CURRENT_DIR}/.wabot_auth|" .env || echo "WWEBJS_SESSION_PATH=${CURRENT_DIR}/.wabot_auth" >> .env
sed -i "s|^WWEBJS_CACHE_PATH=.*|WWEBJS_CACHE_PATH=${CURRENT_DIR}/.wwebjs_cache|" .env || echo "WWEBJS_CACHE_PATH=${CURRENT_DIR}/.wwebjs_cache" >> .env

chown "${USER_NAME}:${USER_NAME}" .env
chmod 600 .env

# ==========================================================
# Output hasil setup
# ==========================================================
echo ""
echo "=================================================="
echo "SETUP SELESAI"
echo "=================================================="
echo "Network     : ${NETWORK_NAME}"
echo "PostgreSQL  : ${GATEWAY_IP}:5432"
echo "DB Name     : ${DB_NAME}"
echo "DB User     : ${DB_USER}"
echo "DB Password : ${DB_PASS}"
echo "Redis       : ${GATEWAY_IP}:6379"
echo "Redis PASS  : ${REDIS_PASS}"
echo ""
echo "WWEBJS_SESSION_PATH: ${CURRENT_DIR}/.wabot_auth"
echo "WWEBJS_CACHE_PATH  : ${CURRENT_DIR}/.wwebjs_cache"
echo ""
echo "Backup konfigurasi disimpan di: ${BACKUP_DIR}"
echo ""
echo "=================================================="
echo "Gunakan perintah berikut untuk menjalankan docker:"
echo "docker compose up -d --build"
echo ""
echo "Untuk melihat log:"
echo "docker compose logs -f wabot-api"
echo ""
echo "Gunakan perintah berikut untuk melihat status:"
echo "docker compose ps"
echo "=================================================="
