# QMS — Queue Management System

Local network web app. No database. No auth. No frills.

## Stack

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (3 views)

## Setup

```bash
cd backend
npm install
npm start
```

Server runs on port **3000**, bound to `0.0.0.0` (all network interfaces).

## Access

| View          | URL                              | Use on              |
|---------------|----------------------------------|---------------------|
| Hub / Home    | `http://<your-ip>:3000`          | Any browser         |
| Counter 1     | `http://<your-ip>:3000/counter.html?c=1` | Counter 1 PC |
| Counter 2     | `http://<your-ip>:3000/counter.html?c=2` | Counter 2 PC |
| Counter 3     | `http://<your-ip>:3000/counter.html?c=3` | Counter 3 PC |
| Admin         | `http://<your-ip>:3000/admin.html`       | Admin PC     |
| Display       | `http://<your-ip>:3000/display.html`     | Wall screen  |

Find your IP: `ipconfig` (Windows) or `ip addr` (Linux/Mac).

## How It Works

1. Open **Admin** → click **Start Queue**
2. Counters can now click **Call Next** (or press `Enter`/`Space`)
3. Server assigns the next sequential number — no duplicates
4. Counter clicks **Mark as Done** (or press `D`) to free the slot
5. Display screen updates in real time

## Rules

- Numbers are global and strictly sequential (1, 2, 3…)
- Each counter holds at most one active number
- Must mark done before calling next
- Reset clears everything back to #1
- State lives in memory — restarting the server resets the queue

## Keyboard Shortcuts (Counter View)

| Key           | Action        |
|---------------|---------------|
| `Enter`/`Space` | Call Next   |
| `D`           | Mark as Done  |

## Project Structure

```
qms/
├── backend/
│   ├── server.js       # Express + Socket.io server
│   └── package.json
└── frontend/
    ├── index.html      # Hub / landing
    ├── shared.css      # Design system
    ├── counter.html    # Counter operator view
    ├── admin.html      # Admin control panel
    └── display.html    # Public display screen
```
