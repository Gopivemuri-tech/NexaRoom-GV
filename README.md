# NexaRoom-GV

**A self-hosted video conferencing and real-time collaboration project built with Python, Django, WebRTC, Socket.IO and MySQL.**

> **Status:** Deployed prototype under active real-user testing. This release is **V9.9** (UI improvements + earlier signaling, media and meeting-capacity updates). It is **not** claimed to be production-ready for 100-person calls.

## Why I built NexaRoom-GV

During my internship, we used Zoom for team discussions. Some meetings ended or were interrupted in the middle of important conversations, and we had to reconnect. That experience motivated me to learn how real-time communication works and to build a meeting platform where I could explore more control over the meeting experience.

The project began as a real-time communication internship exercise. I continued developing it independently as **NexaRoom-GV**, adding collaboration tools, cloud deployment, room controls and iterative real-user testing.

## Features

- Browser-based video and audio meeting rooms powered by WebRTC
- Meeting invitations, configurable durations and participant management
- Screen sharing (subject to browser and device support)
- Real-time chat, reactions and file sharing
- Host and co-host controls, meeting lock and participant limits
- Collaborative whiteboard, meeting notes and browser recording
- Account registration, profile and administration interfaces
- Free / Pro / Business plan interfaces (not a guarantee of meeting capacity)
- Meeting diagnostics for investigating peer connection and video playback issues
- V9.9 UI: side participant layout, More menu grid, chat/file alerts and leave confirmation

## Tech stack

| Layer | Technology |
| --- | --- |
| Application | Python, Django |
| Real-time signaling | Python Socket.IO (ASGI) |
| Audio and video | WebRTC |
| Frontend | HTML, CSS, JavaScript |
| Database | MySQL (PyMySQL) |
| ASGI server | Daphne |
| Cloud deployment used for demo | AWS EC2, Nginx, HTTPS, Coturn |

## Demo

**Live demo:** https://nexaroom-gv.duckdns.org/

**Video walkthrough:** Add the final LinkedIn / demo link after publishing. Avoid including private meeting links, tokens, chat messages or credentials in public recordings.

> The live deployment may change, require authentication, or be temporarily unavailable while testing.

## Project structure

```text
NexaRoom-GV/
├── core/                  # Django app, meetings, models, signaling
├── nexaroom/              # Settings, ASGI/WSGI, URLs
├── static/                # JS and CSS including V9.9 UI styles
├── templates/             # Login, dashboard, meeting UI, admin
├── scripts/               # Optional setup utilities
├── requirements.txt
├── .env.example            # Safe placeholder configuration
└── manage.py
```

## Run locally (Windows PowerShell)

**Prerequisites:** Python 3.11+, MySQL server, Chrome or Edge. A second device usually requires HTTPS for camera/microphone access; `localhost` is accepted for development by modern browsers.

```powershell
# 1. In your repository folder
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 2. Install dependencies
python -m pip install -r requirements.txt

# 3. Configure local database credentials and Django secret
Copy-Item .env.example .env
# Edit .env with your OWN local MySQL credentials and strong admin password

# 4. Prepare database and admin
python manage.py setup_nexaroom

# 5. Check configuration
python manage.py check

# 6. Start ASGI development server (WebSocket support)
daphne -b 127.0.0.1 -p 8000 nexaroom.asgi:application
```

Open **http://127.0.0.1:8000/**. For audio/video meetings, permit browser camera and microphone access.

**Socket.IO browser library:** This project uses a locally served Socket.IO browser client. If `static/js/socket.io.min.js` is missing, run `bash scripts/fetch_socketio.sh` from Git Bash / WSL (internet needed), or install the matching Socket.IO client from an official source. Do not commit downloaded assets with unknown licenses without checking terms.

If you already have an existing database, **do not run setup/migrations blindly** on production. Back up first and review deployment instructions.

## Deployment overview

The public demo has used **AWS EC2, Nginx, Daphne, MySQL, HTTPS and Coturn**. Hosting a public meeting app requires TLS, TURN access controls, protected database ports, environment-based secrets and operational monitoring. This repository does **not** contain production `.env` settings, private keys, user media or database backups.

This GitHub package is reconstructed from the complete V9 application archive and the subsequent V9.1–V9.9 update packages. It has not been copied live from the AWS instance, so if you modified server files manually, verify differences before treating GitHub as a backup of production.

## Architecture and limitations

The current audio/video meeting design uses **peer-to-peer WebRTC mesh**. As participant count grows, each browser must handle more simultaneous media connections. A plan interface advertising a large limit does **not** make 100-user video conferencing reliably supported.

Potential future improvements include an **SFU architecture**, media performance testing, automated browser-based regression tests, TURN/TLS failover and observability.

## Development journey

- **Internship inspiration:** meeting interruptions motivated the project.
- **September 2026:** initial real-time communication prototype.
- **Late September–October 2026:** feature development and UX refinements.
- **October 11, 2026:** AWS-based live deployment milestone.
- **October 12, 2026:** continued multi-user testing, media diagnostics and V9.9 UI improvements.

## Security and privacy

Never commit `.env` files, database exports, SSH keys, TURN credentials, session data, private meeting invite links or recordings with other people's messages. Public deployment settings and dependencies should be independently audited before production use.

## Author

**Gopi Vemuri** — B.Tech, Computer Science and Engineering (Data Science).

_This repository documents my independent continuation of a project that originally began during an internship._
