#!/bin/bash
# ==========================================================
# Setup otomatis Docker network + PostgreSQL + Redis + .env
# ==========================================================

NETWORK_NAME="wabot_network"
CURRENT_DIR=$(pwd)
BACKUP_DIR="/etc/docker-config-backup"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

echo "Mendeteksi versi PostgreSQL..."
PG_VERSION=$(psql -V 2>/dev/null | awk '{print $3}' | cut -d. -f1)

if [ -z "$PG_VERSION" ]; then
  echo "PostgreSQL tidak ditemukan! Pastikan psql terinstal."
  exit 1
fi

PG_CONF_PATH="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"
PG_HBA_PATH="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
REDIS_CONF_PATH="/etc/redis/redis.conf"

echo "PostgreSQL versi ${PG_VERSION} terdeteksi."
echo ""

# ==========================================================
# Buat Docker network jika belum ada
# ==========================================================
echo "Mengecek Docker network '${NETWORK_NAME}'..."
if ! docker network ls | grep -q "${NETWORK_NAME}"; then
  docker network create --driver bridge "${NETWORK_NAME}"
  echo "Network '${NETWORK_NAME}' berhasil dibuat."
else
  echo "Network '${NETWORK_NAME}' sudah ada."
fi

# Dapatkan subnet & gateway
SUBNET=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Subnet}}')
GATEWAY_IP=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Gateway}}')

if [ -z "$SUBNET" ]; then
  echo "Tidak dapat mendeteksi subnet Docker network."
else
  echo "Subnet Docker network : ${SUBNET}"
  echo "Gateway Docker network : ${GATEWAY_IP}"
fi

# ==========================================================
# Buat folder backup konfigurasi
# ==========================================================
sudo mkdir -p "${BACKUP_DIR}"

# ==========================================================
# Backup & Konfigurasi PostgreSQL
# ==========================================================
if [ -f "${PG_CONF_PATH}" ]; then
  echo "Membuat backup konfigurasi PostgreSQL..."
  sudo cp "${PG_CONF_PATH}" "${BACKUP_DIR}/postgresql.conf.bak_${TIMESTAMP}"
  sudo cp "${PG_HBA_PATH}" "${BACKUP_DIR}/pg_hba.conf.bak_${TIMESTAMP}"

  echo "Mengatur PostgreSQL agar listen hanya di 127.0.0.1 dan ${GATEWAY_IP}..."

  if grep -q "^listen_addresses" "${PG_CONF_PATH}"; then
    sudo sed -i "s|^listen_addresses.*|listen_addresses = '127.0.0.1,${GATEWAY_IP}'|" "${PG_CONF_PATH}"
  elif grep -q "^#listen_addresses" "${PG_CONF_PATH}"; then
    sudo sed -i "s|^#listen_addresses.*|listen_addresses = '127.0.0.1,${GATEWAY_IP}'|" "${PG_CONF_PATH}"
  else
    echo "listen_addresses = '127.0.0.1,${GATEWAY_IP}'" | sudo tee -a "${PG_CONF_PATH}" > /dev/null
  fi

  if [ -n "$SUBNET" ] && ! grep -q "${SUBNET}" "${PG_HBA_PATH}"; then
    echo "host    all             all             ${SUBNET}           md5" | sudo tee -a "${PG_HBA_PATH}" > /dev/null
    echo "Menambahkan rule akses untuk subnet ${SUBNET}"
  else
    echo "Rule akses untuk subnet ${SUBNET} sudah ada."
  fi

  sudo systemctl restart postgresql
  echo "PostgreSQL dikonfigurasi dengan benar."
else
  echo "File konfigurasi PostgreSQL tidak ditemukan di ${PG_CONF_PATH}"
fi

# ==========================================================
# Backup & Konfigurasi Redis
# ==========================================================
REDIS_PASS=$(openssl rand -base64 24)

if [ -f "${REDIS_CONF_PATH}" ]; then
  echo "Membuat backup konfigurasi Redis..."
  sudo cp "${REDIS_CONF_PATH}" "${BACKUP_DIR}/redis.conf.bak_${TIMESTAMP}"

  echo "Mengatur Redis agar bind ke 127.0.0.1 dan ${GATEWAY_IP}..."

  if grep -q "^bind" "${REDIS_CONF_PATH}"; then
    sudo sed -i "s|^bind .*|bind 127.0.0.1 ${GATEWAY_IP}|" "${REDIS_CONF_PATH}"
  else
    echo "bind 127.0.0.1 ${GATEWAY_IP}" | sudo tee -a "${REDIS_CONF_PATH}" > /dev/null
  fi

  if grep -q "^requirepass" "${REDIS_CONF_PATH}"; then
    sudo sed -i "s|^requirepass .*|requirepass ${REDIS_PASS}|" "${REDIS_CONF_PATH}"
  else
    echo "requirepass ${REDIS_PASS}" | sudo tee -a "${REDIS_CONF_PATH}" > /dev/null
  fi

  sudo systemctl restart redis
  echo "Redis dikonfigurasi untuk listen pada 127.0.0.1 dan ${GATEWAY_IP}"
else
  echo "File konfigurasi Redis tidak ditemukan di ${REDIS_CONF_PATH}"
fi

# ==========================================================
# Setup file .env otomatis
# ==========================================================
echo ""
echo "Menyiapkan file .env untuk wabot-api..."

if [ ! -f ".env.example" ]; then
  echo "File .env.example tidak ditemukan. Lewati langkah ini."
else
  if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "File .env dibuat dari .env.example"
  else
    echo "File .env sudah ada, hanya diperbarui."
  fi

  sed -i "s|^PORT=.*|PORT=3000|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:password@${GATEWAY_IP}:5432/wabot_db|" .env
  sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASS}@${GATEWAY_IP}:6379|" .env
  sed -i "s|^REDIS_HOST=.*|REDIS_HOST=${GATEWAY_IP}|" .env
  sed -i "s|^REDIS_PORT=.*|REDIS_PORT=6379|" .env
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|" .env
  sed -i "s|^WWEBJS_SESSION_PATH=.*|WWEBJS_SESSION_PATH=${CURRENT_DIR}/.wabot_auth|" .env
  sed -i "s|^WWEBJS_CACHE_PATH=.*|WWEBJS_CACHE_PATH=${CURRENT_DIR}/.wwebjs_cache|" .env
  echo "File .env berhasil diperbarui dengan konfigurasi terbaru."
fi

# ==========================================================
# Output akhir
# ==========================================================
echo ""
echo "=================================================="
echo "SETUP SELESAI"
echo "=================================================="
echo "Network     : ${NETWORK_NAME}"
echo "PostgreSQL  : ${GATEWAY_IP}:5432"
echo "Redis       : ${GATEWAY_IP}:6379"
echo ""
echo "Redis Password:"
echo "${REDIS_PASS}"
echo ""
echo "WWEBJS_SESSION_PATH: ${CURRENT_DIR}/.wabot_auth"
echo "WWEBJS_CACHE_PATH  : ${CURRENT_DIR}/.wwebjs_cache"
echo ""
echo "Backup konfigurasi disimpan di: ${BACKUP_DIR}"
echo ""
echo "Tambahkan ke docker-compose.yml:"
echo "--------------------------------------------------"
echo "services:"
echo "  wabot-api:"
echo "    networks:"
echo "      - ${NETWORK_NAME}"
echo ""
echo "networks:"
echo "  ${NETWORK_NAME}:"
echo "    external: true"
echo "--------------------------------------------------"
