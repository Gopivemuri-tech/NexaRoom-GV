import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','nexaroom.settings')
import django
django.setup()
from django.core.asgi import get_asgi_application
import socketio
from core.realtime import sio
django_asgi=get_asgi_application()
application=socketio.ASGIApp(sio,other_asgi_app=django_asgi,socketio_path='socket.io')
