#!/usr/bin/env python3
"""Only add NexaRoom-GV mobile meeting stylesheet to the meeting template.

No database, models, views, realtime, JS, host transfer or other templates touched.
Safe to run more than once; creates an on-server backup before the first edit.
"""
from pathlib import Path
import sys

project = Path('/opt/nexaroom')
html = project / 'templates/core/meeting_room.html'
css = project / 'static/css/nexaroom-meeting-mobile.css'
needle = "{% static 'css/nexaroom-meeting-mobile.css' %}"
link = f'<link rel="stylesheet" href="{needle}?v=20261011a">'

if not html.is_file():
    sys.exit('ERROR: meeting_room.html missing; leave existing application unchanged.')
if not css.is_file():
    sys.exit('ERROR: mobile stylesheet missing. Unzip patch before applying.')
body = html.read_text(encoding='utf-8')
if needle in body:
    print('ALREADY APPLIED: meeting room stylesheet link is present. No changes made.')
    sys.exit(0)
if 'class="meeting-body"' not in body or '</head>' not in body:
    sys.exit('ERROR: Unexpected meeting template. No changes made.')
backup = html.with_suffix(html.suffix + '.before-mobile-layout')
if not backup.exists():
    backup.write_bytes(html.read_bytes())
    print('Backup saved:', backup)
updated = body.replace('</head>', f'{link}\n</head>', 1)
html.write_text(updated, encoding='utf-8')
print('SUCCESS: Added ONE mobile-only stylesheet link to meeting_room.html')
print('No backend, JS, WebRTC, participant or host-transfer functions were changed.')
