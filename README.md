# Baji Prints

Fine art print atelier — Zürich Wiedikon.

## Stack
- Node.js + Express
- PostgreSQL (Railway)
- Cloudinary (image storage)
- Resend (contact form emails)

## Local development

```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run dev
```

Visit `http://localhost:3000` for the site, `/admin` for the admin panel.

## Deploy to Railway

1. Push this repo to GitHub
2. New Railway project → Deploy from GitHub repo → select this repo
3. Add a PostgreSQL database service in Railway
4. Set environment variables (copy from `.env.example`):
   - `DATABASE_URL` — auto-set by Railway when you link the Postgres service
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   - `ADMIN_PASSWORD` — choose something strong
   - `SESSION_SECRET` — long random string
   - `RESEND_API_KEY`
   - `EMAIL_TO` — where contact form emails go
   - `EMAIL_FROM` — must be a verified domain in Resend
5. Railway auto-deploys on every push to main

## Admin panel

Visit `/admin` on your deployed site. Login with `ADMIN_PASSWORD`.

You can edit:
- All text on the site (hero, about, papers, contact info)
- Hero image
- Portfolio prints (add/remove)
