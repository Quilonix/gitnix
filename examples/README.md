# Gitnix Events

A multi-user event registration web app with admin panel, powered by **Gitnix encrypted database**.

All user data, events, and registrations are encrypted at rest using XSalsa20-Poly1305 (256-bit). The database is stored as encrypted files locally (with optional GitHub sync via Gitnix).

---

## Features

- **Public event listing** — Browse upcoming events, view details and availability
- **User authentication** — Signup/login with bcrypt password hashing + JWT sessions
- **Event registration** — Register for events, view your registrations, cancel
- **Admin panel** — Create/edit/delete events, manage users, view registration lists
- **Role-based access** — Admin vs Attendee roles
- **Encrypted storage** — All data encrypted on disk using tweetnacl
- **Security** — Helmet headers, CORS, rate limiting, input validation, httpOnly cookies

---

## Quick Start

### 1. Install dependencies

```bash
cd event-app
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your settings (DB_PASSWORD, JWT_SECRET, etc.)
```

### 3. Run the server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

### 4. Open in browser

```
http://localhost:3000
```

Default admin credentials (change in `.env`):
- Email: `admin@example.com`
- Password: `admin123`

---

## API Endpoints

### Public
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/events` | List all events |
| GET | `/api/events/:id` | Event details |

### Authentication
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/signup` | Create account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current user info |

### Authenticated (Attendees)
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/events/:id/register` | Register for event |
| DELETE | `/api/events/:id/register` | Cancel registration |
| GET | `/api/my/registrations` | My registrations |

### Admin Only
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/admin/events` | Create event |
| PUT | `/api/admin/events/:id` | Update event |
| DELETE | `/api/admin/events/:id` | Delete event |
| GET | `/api/admin/events/:id/registrations` | Event registrations |
| GET | `/api/admin/users` | List all users |
| PUT | `/api/admin/users/:id/role` | Change user role |
| DELETE | `/api/admin/users/:id` | Delete user |
| GET | `/api/admin/stats` | Dashboard statistics |

---

## Security

| Feature | Implementation |
|---------|---------------|
| Password hashing | bcryptjs (12 salt rounds) |
| Session tokens | JWT (HS256, httpOnly cookie + Bearer header) |
| Data encryption | XSalsa20-Poly1305 via tweetnacl |
| Headers | Helmet (CSP, HSTS, X-Frame-Options, etc.) |
| Rate limiting | express-rate-limit (100 req/15min general, 20/15min auth) |
| Input validation | Server-side validation on all endpoints |
| CORS | Configurable allowed origins |
| XSS prevention | Output escaping, CSP headers |

---

## Project Structure

```
event-app/
├── server.mjs          # Express server (routes + middleware)
├── db.mjs              # Encrypted database layer (Gitnix/tweetnacl)
├── auth.mjs            # Auth helpers (bcrypt, JWT, middleware)
├── public/             # Frontend (vanilla HTML/CSS/JS)
│   ├── index.html      # SPA shell
│   ├── app.js          # Client-side logic
│   └── style.css       # Responsive styles
├── .data/              # Encrypted database files (gitignored)
├── .env                # Environment secrets (gitignored)
├── .env.example        # Template for developers
├── package.json
└── README.md
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `DB_PASSWORD` | Master encryption key for database | (required) |
| `JWT_SECRET` | Secret for signing JWT tokens | (required) |
| `JWT_EXPIRES_IN` | Token expiry duration | `7d` |
| `ADMIN_EMAIL` | Default admin email | `admin@example.com` |
| `ADMIN_PASSWORD` | Default admin password | `admin123` |
| `CORS_ORIGIN` | Allowed CORS origins | `http://localhost:3000` |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |
| `RATE_LIMIT_WINDOW_MIN` | Rate limit window (minutes) | `15` |

---

## License

MIT
