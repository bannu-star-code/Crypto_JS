# Crypto portfolio

A JavaScript web app built with Express and EJS. It provides public CoinGecko coin search and a signed-in Delta Exchange India portfolio with wallet balances, open positions, and explicitly confirmed spot orders.

## Requirements

- Node.js 20 or later
- npm

## Run locally

1. Install dependencies:
   ```sh
   npm ci
   ```
2. Copy `.env.example` to `.env` if you need to configure credentials or settings. Never commit `.env`.
3. Start the server:
   ```sh
   npm start
   ```
4. Open `http://127.0.0.1:3000/`. Coin search is public. Create an account at `/signup/`, then sign in to view `/portfolio/`.

The local SQLite database is created at `data/app.sqlite3`. The old Django database, `db.sqlite3`, is deliberately left untouched. Set `SQLITE_PATH` to choose another SQLite file.

Registration is enabled by default in development. Set `ALLOW_SIGNUPS=false` to disable it. Production disables registration by default. To create a production account while registration is disabled, use:

```sh
npm run create-user -- <username>
```

The command prompts for the password without echoing it and writes a bcrypt hash to the configured JavaScript database.

## Delta Exchange

The coin search needs no exchange credentials. For private portfolio data and live spot orders, configure a dedicated Delta Exchange India API key in `.env`:

```env
DELTA_API_KEY=your_delta_api_key
DELTA_API_SECRET=your_delta_api_secret
```

Delta's [official API documentation](https://docs.delta.exchange/) indicates account endpoints and order placement require **Trading** permission. That permission may allow other trading actions on the account. Use a dedicated, IP-restricted key and understand its permissions. Never commit or paste credentials into source control or chat.

If Delta returns `ip_not_whitelisted_for_api_key`, add the public outbound IP of the machine running this app to the API key's IP whitelist in Delta Exchange. The app server's IP is what Delta checks, not the browser's IP. Local development and hosted deployments may have different outbound IPs; use a stable egress IP for hosted deployments and allowlist that address.

Only Delta products reported as live operational spot markets are offered. Each order requires a preview and a separate confirmation within five minutes. Confirmations are signed, user-bound, revalidated against the current market rules, and accepted once. Market INR sizing is an estimate; submission does not guarantee a fill. The order-preview and confirmation endpoints accept loopback requests only. Run locally on `127.0.0.1`; do not expose the trading app publicly. Keep any hosted portfolio private and do not configure an exchange key there unless the access model and key permissions have been reviewed.

## Database

SQLite is used locally unless `DATABASE_URL` or `SUPABASE_DB_URL` is set. The app also supports PostgreSQL:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
```

For Supabase, use the PostgreSQL connection string (not an `anon` or `service_role` API key) and set:

```env
SUPABASE_DB_URL=postgresql://user:password@host:5432/database
```

For a PostgreSQL server whose certificate is signed by a private CA, configure the trusted CA PEM certificate. Supabase provides its database CA certificate in the project's **Database → Settings → SSL Configuration** page. Locally, set `DATABASE_SSL_CA_FILE` to the path of the downloaded PEM file. On Vercel, where a local machine's file path will not exist, set `DATABASE_SSL_CA_PEM` to the certificate contents in the project's environment variables (multiline PEM or literal `\n` line breaks). Set only one of these variables. For example:

```env
SUPABASE_DB_URL=postgresql://postgres.[project-ref]:[password]@[host]:5432/postgres
DATABASE_SSL_CA_FILE=/absolute/path/to/supabase-ca.crt
```

For Vercel, configure `SUPABASE_DB_URL` and `DATABASE_SSL_CA_PEM` in the Vercel project settings instead of setting `DATABASE_SSL_CA_FILE`.

The app removes TLS query flags from the URL when applying its explicit verified TLS configuration, so `sslmode=require` in a Supabase connection string will not override the supplied CA. It continues to verify the server certificate; do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`. If this error occurs with a local network, VPN, or proxy, obtain the correct CA certificate from your database administrator or network administrator rather than trusting an unverified certificate.

The application creates its own `users`, `sessions`, and `used_trade_confirmations` tables. It does not modify Django's existing tables. For the safest transition, point the JavaScript app at a new database. If you reuse the old PostgreSQL database, the app adds its own tables while leaving Django data/tables in place.

### Existing Django accounts and data

The former local Django database remains at `db.sqlite3`; the JavaScript app does not open, migrate, or overwrite it. Django user passwords use a different password-hash format from the JavaScript app, so the existing password hashes cannot be copied as bcrypt hashes. Create new JavaScript accounts (or plan a separately reviewed export/import and password-reset process) before retiring the Django deployment. No automatic migration is performed.

## Deploying to Vercel

The app can be deployed from GitHub as a Vercel Express application. Vercel runs it as a serverless function, so configure a persistent PostgreSQL database; the local SQLite database is not suitable for deployment.

1. Import this repository from GitHub in Vercel and use the repository root as the project root. Vercel detects the Express entry point automatically.
2. Set the project environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET` to a long, random secret
   - `DATABASE_URL` to a PostgreSQL connection string (or use `SUPABASE_DB_URL` for Supabase)
   - `ALLOW_SIGNUPS=false`
   - `TRUST_PROXY=true`
   - `DELTA_API_KEY` and `DELTA_API_SECRET` only if you intend to fetch private portfolio data
3. Deploy the project. On the first request, the app initializes its JavaScript tables in the configured database.
4. Create an account against that same database from a trusted local terminal. Set `DATABASE_URL` (or `SUPABASE_DB_URL`) and run `npm run create-user -- <username>`; the command prompts for the password without echoing it.

The app's dashboard is public; portfolio pages require login, and registrations are disabled in production. Enable Vercel deployment protection if the entire site must be private. Do not put credentials in GitHub or paste them into chat; configure them in Vercel's encrypted environment-variable settings. Vercel's outbound IP must also be accepted by Delta's API-key whitelist for private portfolio requests. Check Vercel's current egress-IP options for your plan before adding an allowlist; without a stable, allowlistable egress IP, Delta may return `ip_not_whitelisted_for_api_key`. Hosted spot-order submissions remain disabled because the app only permits trading requests from loopback clients.

## Deploying to Render

This app can be run as a Node web service. For a private deployment:

1. Create a Render web service connected to the repository.
2. Set **Build Command** to `npm ci`.
3. Set **Start Command** to `npm start`.
4. Configure:
   - `NODE_ENV=production`
   - `SESSION_SECRET` with a long random value
   - `DATABASE_URL` with a PostgreSQL connection string
   - `ALLOW_SIGNUPS=false`
   - `DELTA_API_KEY` and `DELTA_API_SECRET` only if required
5. Create an account from the Render shell:
   ```sh
   npm run create-user -- <username>
   ```

Render supplies `PORT`; the app binds to `0.0.0.0` in production. The trading routes still reject non-loopback clients, so a hosted service cannot place orders through this UI. Use an internal connection string for a same-region Render PostgreSQL database. For Supabase, use `SUPABASE_DB_URL`; SSL certificate verification is enabled.

## Development and tests

```sh
npm run dev
npm test
```

CoinGecko prices are public market quotes, not exchange balances or guaranteed execution prices. Coin symbols can be shared by multiple tokens, so check the coin name too.
