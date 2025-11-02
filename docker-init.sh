#!/bin/bash
# ==========================================================
# Setup otomatis Docker network + PostgreSQL + Redis + .env
# ==========================================================

NETWORK_NAME="wabot_network"
CURRENT_DIR=$(pwd) # lokasi direktori saat ini

echo "Mendeteksi versi PostgreSQL yang terinstal..."
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
echo "Mengecek network '${NETWORK_NAME}'..."
if ! docker network ls | grep -q "${NETWORK_NAME}"; then
  docker network create --driver bridge "${NETWORK_NAME}"
  echo "Network '${NETWORK_NAME}' berhasil dibuat."
else
  echo "Network '${NETWORK_NAME}' sudah ada."
fi

# Dapatkan subnet & gateway network dari Docker
SUBNET=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Subnet}}')
GATEWAY_IP=$(docker network inspect "${NETWORK_NAME}" -f '{{(index .IPAM.Config 0).Gateway}}')

if [ -z "$SUBNET" ]; then
  echo "Tidak dapat mendeteksi subnet Docker network."
else
  echo "Subnet Docker network : ${SUBNET}"
  echo "Gateway Docker network : ${GATEWAY_IP}"
fi

# ==========================================================
# Konfigurasi PostgreSQL listen address & akses
# ==========================================================
if [ -f "${PG_CONF_PATH}" ]; then
  echo "Mengatur PostgreSQL agar listen hanya pada localhost dan ${GATEWAY_IP}..."

  sudo sed -i "s/^#listen_addresses.*/listen_addresses = '127.0.0.1,${GATEWAY_IP}'/" "${PG_CONF_PATH}"
  sudo sed -i "s/^listen_addresses.*/listen_addresses = '127.0.0.1,${GATEWAY_IP}'/" "${PG_CONF_PATH}"

  if [ -n "$SUBNET" ] && ! grep -q "${SUBNET}" "${PG_HBA_PATH}"; then
    echo "host    all             all             ${SUBNET}           md5" | sudo tee -a "${PG_HBA_PATH}" > /dev/null
    echo "Menambahkan rule akses untuk subnet ${SUBNET}"
  fi

  sudo systemctl restart postgresql
  echo "PostgreSQL dikonfigurasi hanya untuk listen di localhost dan ${GATEWAY_IP}"
else
  echo "File konfigurasi PostgreSQL tidak ditemukan di ${PG_CONF_PATH}"
fi

# ==========================================================
# Konfigurasi Redis
# ==========================================================
REDIS_PASS=$(openssl rand -base64 24)

if [ -f "${REDIS_CONF_PATH}" ]; then
  echo "Mengatur Redis agar bind ke 127.0.0.1 dan ${GATEWAY_IP}..."

  sudo sed -i "s/^bind .*/bind 127.0.0.1 ${GATEWAY_IP}/" "${REDIS_CONF_PATH}"

  if grep -q "^requirepass" "${REDIS_CONF_PATH}"; then
    sudo sed -i "s/^requirepass .*/requirepass ${REDIS_PASS}/" "${REDIS_CONF_PATH}"
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
    echo "File .env sudah ada, tidak di-overwrite."
  fi

  sed -i "s|^PORT=.*|PORT=3000|" .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:password@${GATEWAY_IP}:5432/wabot_db|" .env
  sed -i "s|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASS}@${GATEWAY_IP}:6379|" .env
  sed -i "s|^REDIS_HOST=.*|REDIS_HOST=${GATEWAY_IP}|" .env
  sed -i "s|^REDIS_PORT=.*|REDIS_PORT=6379|" .env
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|" .env
  sed -i "s|^WWEBJS_SESSION_PATH=.*|WWEBJS_SESSION_PATH=${CURRENT_DIR}/.wabot_auth|" .env
  sed -i "s|^WWEBJS_CACHE_PATH=.*|WWEBJS_CACHE_PATH=${CURRENT_DIR}/.wwebjs_cache|" .env
  echo "File .env berhasil diperbarui dengan konfigurasi terkini."
fi

# ==========================================================
# Output akhir
# ==========================================================
echo ""
echo "=================================================="
echo "SETUP SELESAI"
echo "=================================================="
echo ""
echo "Network     : ${NETWORK_NAME}"
echo "PostgreSQL  : ${GATEWAY_IP}:5432"
echo "Redis       : ${GATEWAY_IP}:6379"
echo ""
echo "Redis Password (simpan dengan aman):"
echo "${REDIS_PASS}"
echo ""
echo "WWEBJS_SESSION_PATH: ${CURRENT_DIR}/.wabot_auth"
echo "WWEBJS_CACHE_PATH  : ${CURRENT_DIR}/.wwebjs_cache"
echo ""
echo "Tambahkan konfigurasi network ke docker-compose.yml:"
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
