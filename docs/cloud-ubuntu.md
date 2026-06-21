# Cloud Ubuntu Setup

This app can run on a private Ubuntu VM, such as Oracle Cloud Always Free. Keep the settings GUI bound to `127.0.0.1` and access it through SSH tunneling.

## Layout

Recommended paths:

```text
/opt/message-automation-hub
/home/opc/secrets/message-automation-hub/.env
/home/opc/secrets/message-automation-hub/secrets.json
```

Use your VM username instead of `opc` if different.

## Install Runtime Dependencies

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 xdg-utils
```

Install Node.js 22 with your preferred method, then:

```bash
sudo mkdir -p /opt/message-automation-hub
sudo chown "$USER:$USER" /opt/message-automation-hub
git clone <your-repo-url> /opt/message-automation-hub
cd /opt/message-automation-hub
npm install
npm run build
```

## Configure Env

```bash
mkdir -p ~/secrets/message-automation-hub
cp .env.example ~/secrets/message-automation-hub/.env
chmod 700 ~/secrets/message-automation-hub
chmod 600 ~/secrets/message-automation-hub/.env
```

Edit:

```bash
nano ~/secrets/message-automation-hub/.env
```

Set:

```text
MESSAGE_HUB_SECRET_STORE=file
MESSAGE_HUB_SECRET_FILE=/home/opc/secrets/message-automation-hub/secrets.json
```

Save the SMTP app password:

```bash
MESSAGE_HUB_SECRET_STORE=file \
MESSAGE_HUB_SECRET_FILE=/home/opc/secrets/message-automation-hub/secrets.json \
npm run secret:set:smtp
```

## Settings GUI Through SSH

On your local machine:

```powershell
ssh -L 8787:127.0.0.1:8787 opc@YOUR_VM_IP
```

On the VM:

```bash
cd /opt/message-automation-hub
MESSAGE_HUB_SETTINGS_PORT=8787 npm run settings
```

Open the printed tokenized URL locally:

```text
http://127.0.0.1:8787/?token=...
```

## Run as a Service

Copy the template:

```bash
sudo cp deploy/systemd/message-automation-hub.service /etc/systemd/system/message-automation-hub.service
sudo systemctl daemon-reload
sudo systemctl enable message-automation-hub
sudo systemctl start message-automation-hub
```

View logs:

```bash
journalctl -u message-automation-hub -f
```

## Notes

- The WhatsApp session is stored in `.wwebjs_auth` inside the project directory. Keep that directory persistent.
- The settings GUI is not exposed publicly. Use an SSH tunnel.
- Cloud/datacenter IPs may be more suspicious to WhatsApp than a home IP.
