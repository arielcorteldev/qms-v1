# QMS — Queue Management System

Local network web app. No database. No frills.

## Stack

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (hub, counter, admin, display)

## Setup

```bash
cd backend
npm install
ADMIN_PIN=1234 npm start
```

On Windows (PowerShell):

```powershell
cd backend
npm install
$env:ADMIN_PIN="1234"; npm start
```

Server runs on port **3000**, bound to `0.0.0.0` (all network interfaces).

| Variable         | Default              | Purpose                                              |
|------------------|----------------------|------------------------------------------------------|
| `ADMIN_PIN`      | *(none)*             | PIN for admin actions. If unset, all admin actions are refused. |
| `PORT`           | `3000`               | HTTP port                                            |
| `QMS_STATE_FILE` | `backend/state.json` | Where the queue state is saved                       |

When running as a Windows service with NSSM:

```
nssm set QMS AppEnvironmentExtra PORT=3000 ADMIN_PIN=yourpin
```

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

1. Open **Admin** → click **Start Queue** (enter the admin PIN when asked)
2. Counters can now click **Call Next** or **Call Priority**
3. Server assigns the next number in that line — no duplicates
4. Counter clicks **Mark as Done** to free the slot
5. Display screen updates in real time and announces the called number aloud

## Rules

- Two lines: regular (1, 2, 3…) and priority (P1, P2, P3…), each strictly sequential
- Each counter holds at most one active number
- Must mark done before calling next — except calling regular while holding a priority number, which cancels it and returns it to the priority line (it is re-issued first)
- Admin actions (start, reset, rename counter, enable/disable counter) require the PIN; 5 wrong PINs locks that device out for 60 seconds
- Reset clears everything back to #1
- State is saved to disk after every change. Restarting the server the same day restores the queue; the first start on a new day begins fresh from #1

## Keyboard Shortcuts (Counter View)

| Key             | Action        |
|-----------------|---------------|
| `Enter`/`Space` | Call Next     |
| `P`             | Call Priority |
| `D`             | Mark as Done  |

## Project Structure

```
qms/
├── backend/
│   ├── server.js       # Express + Socket.io server
│   └── package.json
└── frontend/
    ├── index.html      # Hub / landing
    ├── counter.html    # Counter operator view
    ├── admin.html      # Admin control panel
    ├── display.html    # Public display screen
    ├── css/
    │   ├── tokens.css  # Design tokens (colors, spacing, type)
    │   └── styles.css  # All component and page styles
    └── assets/
        ├── fonts/      # Local Inter + Public Sans (OFL), required by styles.css
        └── logos/      # Office logos
```
