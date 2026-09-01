# Install the Quattro-compatible fork

## Requirements

- Git;
- Node.js `>=22.22.3 <23` or `>=24 <27` (Node 24 LTS recommended);
- npm 10 or newer;
- optional Docker with Compose v2.

## Source install

```bash
git clone https://github.com/hehehezzer/OmniRoute.git
cd OmniRoute
cp .env.example .env
printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48)" >> .env
printf 'API_KEY_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
npm ci
npm run build
npm run start
```

The dashboard defaults to <http://localhost:20128>. OpenAI-compatible clients use
`http://localhost:20128/api/v1` (or the upstream-compatible `/v1` paths documented in the main
README). Configure provider connections in the dashboard; never commit provider credentials or a
runtime `.env` file.

For development, use `npm run dev`. Validate a checkout with:

```bash
npm run lint
npm run typecheck:core
npm run test:unit
npm run test:integration
npm run build
npm run check:secrets
npm run check:public-creds
```

## Docker

Build locally so the result contains this fork's source rather than the upstream published image:

```bash
docker build -t omniroute-quattro:local .
docker run --rm \
  --env-file .env \
  -p 127.0.0.1:20128:20128 \
  -v omniroute-quattro-data:/app/data \
  omniroute-quattro:local
```

For Compose, review `docker-compose.yml`, keep the service bound to the intended interface, and
provide secrets through an untracked `.env` or deployment secret manager. No real provider
credential is required for build, lint, typecheck, or mocked test suites.

## Enhanced routing smoke

After startup and provider configuration:

```bash
curl --fail --silent http://localhost:20128/api/v1/capabilities
curl --fail --silent 'http://localhost:20128/api/v1/routing/candidates?channel=auto'
```

When API-key enforcement is enabled, add `Authorization: Bearer <your-local-api-key>`. Do not put
keys in shell history, documentation, issue reports, or committed scripts. See
[Quattro integration](../integrations/quattro.md) for standard and enhanced request behavior.
