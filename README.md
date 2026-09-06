# 📱 Tapowan Public School - WhatsApp Cloud Gateway

A standalone, 24/7 dedicated microservice for sending automated WhatsApp messages, school fee due alerts, exam marks, and student notifications.

---

## ⚡ Free 24/7 Deployment on Google Cloud (Always Free $0/mo)

### Step 1: Create Free VM on Google Cloud Console
1. Open **[Google Cloud Console](https://console.cloud.google.com/)** ➔ **Compute Engine** ➔ **VM Instances**.
2. Click **Create Instance**:
   - **Name**: `tps-whatsapp-gateway`
   - **Region**: `us-central1` (Iowa) or `us-east1`
   - **Machine Type**: `e2-micro` (2 vCPU, 1 GB RAM — **Always Free**)
   - **Boot Disk**: `Ubuntu 22.04 LTS` (Size: `30 GB` Standard Disk)
   - **Firewall**: Check ✅ **Allow HTTP traffic** and ✅ **Allow HTTPS traffic**
3. Click **Create**.

---

### Step 2: Open Firewall Port 3001
1. In Google Cloud Console, go to **VPC network ➔ Firewall**.
2. Click **Create Firewall Rule**:
   - **Name**: `allow-whatsapp-gateway`
   - **Targets**: `All instances in the network`
   - **Source IPv4 ranges**: `0.0.0.0/0`
   - **Specified protocols and ports**: Check `TCP` ➔ Enter `3001`
3. Click **Create**.

---

### Step 3: Run 1-Click Installer
1. Click the **SSH** button next to your VM instance to open the terminal.
2. Clone or paste this project into the VM, then run:

```bash
git clone https://github.com/aatifakram/Tapowan-WhatsApp-Gateway.git ~/whatsapp-gateway || mkdir -p ~/whatsapp-gateway
cd ~/whatsapp-gateway
chmod +x setup.sh
./setup.sh
```

---

### Step 4: Scan QR Code & Connect WhatsApp
1. Open your browser to:
   `http://<YOUR_VM_EXTERNAL_IP>:3001`
2. Open WhatsApp on your phone ➔ **Linked Devices** ➔ **Link a device** ➔ Scan the QR code.
3. The dashboard will show **🟢 Connected 24/7**!

---

## 📡 REST API Documentation

### 1. Check Gateway Status
```http
GET /api/status
```
**Response:**
```json
{
  "status": "connected",
  "phone": "919876543210",
  "uptime": 120500
}
```

### 2. Send Message
```http
POST /api/send
Content-Type: application/json
x-api-key: tps_secret_gateway_key_2026

{
  "to": "919876543210",
  "message": "🏫 Tapowan Public School: Fee Due Reminder for April 2026."
}
```

### 3. Send Bulk Messages (with auto rate-limiting protection)
```http
POST /api/send-bulk
Content-Type: application/json

{
  "messages": [
    { "to": "919876543210", "message": "Notice for Class X..." },
    { "to": "919876543211", "message": "Notice for Class IX..." }
  ]
}
```
