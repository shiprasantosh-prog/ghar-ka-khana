# Ghar ka Khana — full-stack starter (admin dashboard milestone)

Premium dark-and-gold website foundation using Node.js, Express and SQLite.

## Local setup
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set a unique long `JWT_SECRET`, and set `ADMIN_NAME`, `ADMIN_PHONE`, and a strong `ADMIN_PASSWORD` (8+ characters). Never commit `.env`.
4. Run `npm install` and `npm start`.
5. Open `http://localhost:3000` for the customer preview and `http://localhost:3000/admin.html` for the owner dashboard.

On startup, the server creates the admin account if `ADMIN_PHONE` and `ADMIN_PASSWORD` are set and that phone number is not already registered. If the phone already belongs to a customer, use a different phone for the owner account. The seeded menu is sample content and should be reviewed before public ordering.

## Owner dashboard
- Sign in at `/admin.html` with the configured owner phone and password.
- Add dishes with category, price, description and optional image URL.
- Edit prices/details, mark dishes available/unavailable, and remove dishes from the public menu.
- Menu changes are saved through authenticated server API endpoints.

## API foundation
- Customer registration/login/logout/me
- Public menu listing and owner-only menu CRUD/archive
- Authenticated order creation with server-side price validation
- Customer order history
- Owner order listing and status changes
- Optional WhatsApp Cloud API notification (requires valid Meta credentials and compliant recipient opt-in)

## Important deployment notes
- This is a development milestone, not yet a production-ready store. The customer checkout UI is not yet connected to the API, and order management screens need completion.
- SQLite on ephemeral/free application storage may lose data on redeploy/restart. Use a persistent disk or managed database before taking real orders.
- Configure HTTPS, strong secrets, backups, monitoring, rate limiting, privacy/terms/cancellation policies, and review security before launch.
- Never commit `.env`, passwords, JWT secrets or WhatsApp tokens.
