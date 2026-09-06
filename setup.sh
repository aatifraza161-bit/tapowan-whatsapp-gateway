#!/bin/bash
set -e

echo "============================================================"
echo "🚀 TAPOWAN PUBLIC SCHOOL - WHATSAPP GATEWAY INSTALLER"
echo "============================================================"

# 1. Update OS packages
echo "📦 Updating system packages..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential

# 2. Setup 2GB Swap Memory (for rock-solid stability on 1GB RAM VM)
if [ ! -f /swapfile ]; then
    echo "🧠 Creating 2GB Swapfile for memory optimization..."
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3. Install Node.js 20.x LTS
if ! command -v node &> /dev/null; then
    echo "⚡ Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "✅ Node.js $(node -v) installed."

# 4. Install PM2 process manager
if ! command -v pm2 &> /dev/null; then
    echo "⚙️ Installing PM2 process manager..."
    sudo npm install -g pm2
fi

# 5. Install Gateway Dependencies
echo "📦 Installing WhatsApp Gateway dependencies..."
npm install

# 6. Start with PM2
echo "🚀 Starting WhatsApp Gateway with PM2..."
pm2 stop tps-whatsapp 2>/dev/null || true
pm2 delete tps-whatsapp 2>/dev/null || true
pm2 start server.js --name "tps-whatsapp"

# 7. Enable Auto-restart on VM reboot
pm2 startup systemd -u $USER --hp $HOME || true
pm2 save

PUBLIC_IP=$(curl -s ifconfig.me || echo "YOUR_SERVER_IP")

echo "============================================================"
echo "🎉 WHATSAPP GATEWAY INSTALLED AND RUNNING 24/7!"
echo "============================================================"
echo "🌐 Web Dashboard & QR Scanner: http://${PUBLIC_IP}:3001"
echo "📋 View Live Logs & QR in terminal: pm2 logs tps-whatsapp"
echo "============================================================"
