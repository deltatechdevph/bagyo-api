# Deploying BagyoAPI on a VPS (Hetzner)

One small VPS runs the whole stack (API, worker, Postgres, Redis, Caddy with
automatic HTTPS) via docker compose. Tested sizing: Hetzner CX22 (2 vCPU / 4 GB,
~€4/mo) is comfortable; CAX11 (ARM, ~€3.3/mo) also works — the images are
multi-arch-buildable since everything is plain Node.

## 1. Create the server

1. https://console.hetzner.com → _Servers_ → _Add Server_
2. Location: Singapore (`sin`) is closest to PH users; any works.
3. Image: **Ubuntu 24.04**. Type: **CX22** (or CAX11 for ARM).
4. Add your SSH key. Create the server and note its public IP.
5. (Recommended) In _Firewalls_, allow inbound TCP **22, 80, 443** only.

## 2. Point a domain at it

Any of:

- A domain you own: add an `A` record, e.g. `api.yourdomain.com → <server IP>`.
- Free: https://www.duckdns.org — claim `yourname.duckdns.org`, set it to the IP.

Caddy will obtain and renew the Let's Encrypt certificate automatically.

## 3. Install Docker and get the code

SSH in as root:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/<you>/bagyo-api.git /opt/bagyo-api
cd /opt/bagyo-api
```

## 4. Configure production secrets

```bash
cat > .env <<EOF
DOMAIN=api.yourdomain.com
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_SECRET=$(openssl rand -hex 32)
SCRAPER_USER_AGENT=BagyoAPI/1.0 (+https://api.yourdomain.com)
# Set after step 6 (RapidAPI dashboard), then re-run the compose command:
# RAPIDAPI_PROXY_SECRET=
EOF
chmod 600 .env
```

## 5. Launch

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

First build takes a few minutes. Then verify:

```bash
curl https://api.yourdomain.com/v1/health          # {"status":"ok",...}
curl -s https://api.yourdomain.com/metrics         # 404 (blocked at the proxy)
docker compose logs worker | tail                  # ingestion schedules registered
```

Create your own admin/test key (the demo seed is intentionally NOT run in prod):

```bash
curl -s -X POST https://api.yourdomain.com/v1/account/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"<strong password>"}'
# → data.apiKey shown once
```

The worker polls PAGASA live (10 min while a cyclone is active, 30 min otherwise).
Outside typhoon events the API legitimately reports no active cyclones.

## 6. Updating

```bash
cd /opt/bagyo-api && git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run automatically via the `migrate` service before the API starts.

## Costs

- Hetzner CX22: ~€3.79/mo + ~€0.60 IPv4 (or CAX11 ARM ~€3.29/mo)
- Domain: free with DuckDNS, or ~$10/yr for your own
