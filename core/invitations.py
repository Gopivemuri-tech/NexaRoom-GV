"""Signed meeting invitations for locked rooms; this is not a login token."""
from django.core import signing

SALT = 'nexaroom-gv-meeting-invitation-v1'
MAX_AGE_SECONDS = 7 * 24 * 3600

def create_invitation(meeting):
    return signing.dumps({'meeting': str(meeting.id)}, salt=SALT)

def is_valid_invitation(meeting_id, token):
    if not token or len(token) > 1000:
        return False
    try:
        payload = signing.loads(token, salt=SALT, max_age=MAX_AGE_SECONDS)
    except (signing.BadSignature, signing.SignatureExpired, ValueError, TypeError):
        return False
    return isinstance(payload, dict) and payload.get('meeting') == str(meeting_id)
