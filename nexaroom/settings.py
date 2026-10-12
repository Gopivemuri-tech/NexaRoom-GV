import os
from pathlib import Path
from dotenv import load_dotenv
BASE_DIR=Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR/'.env')
SECRET_KEY=os.getenv('DJANGO_SECRET_KEY','dev-change-me')
DEBUG=os.getenv('DJANGO_DEBUG','True').lower()=='true'
_hosts_env=os.getenv('DJANGO_ALLOWED_HOSTS','').strip()
ALLOWED_HOSTS=[x.strip() for x in _hosts_env.split(',') if x.strip()] if _hosts_env else (['*'] if DEBUG else ['127.0.0.1','localhost'])
NEXAROOM_PUBLIC_BASE_URL=os.getenv('NEXAROOM_PUBLIC_BASE_URL','')
INSTALLED_APPS=([] if os.getenv('NEXAROOM_SKIP_DAPHNE','').lower() in {'1','true','yes'} else ['daphne'])+['django.contrib.admin','django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','django.contrib.messages','django.contrib.staticfiles','channels','core.apps.CoreConfig']
MIDDLEWARE=['django.middleware.security.SecurityMiddleware','django.contrib.sessions.middleware.SessionMiddleware','django.middleware.common.CommonMiddleware','django.middleware.csrf.CsrfViewMiddleware','django.contrib.auth.middleware.AuthenticationMiddleware','django.contrib.messages.middleware.MessageMiddleware','django.middleware.clickjacking.XFrameOptionsMiddleware']
ROOT_URLCONF='nexaroom.urls'
TEMPLATES=[{'BACKEND':'django.template.backends.django.DjangoTemplates','DIRS':[BASE_DIR/'templates'],'APP_DIRS':True,'OPTIONS':{'context_processors':['django.template.context_processors.request','django.contrib.auth.context_processors.auth','django.contrib.messages.context_processors.messages','core.context_processors.brand_context']}}]
WSGI_APPLICATION='nexaroom.wsgi.application'
ASGI_APPLICATION='nexaroom.asgi.application'
if os.getenv('DB_ENGINE','mysql').lower()=='sqlite':
    DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':BASE_DIR/'test.sqlite3'}}
else:
    DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':os.getenv('MYSQL_DATABASE','nexaroom'),'USER':os.getenv('MYSQL_USER','root'),'PASSWORD':os.getenv('MYSQL_PASSWORD',''),'HOST':os.getenv('MYSQL_HOST','127.0.0.1'),'PORT':os.getenv('MYSQL_PORT','3306'),'OPTIONS':{'charset':'utf8mb4'}}}
AUTH_PASSWORD_VALIDATORS=[]
LANGUAGE_CODE='en-us'
TIME_ZONE='Asia/Kolkata'
USE_I18N=True
USE_TZ=True
STATIC_URL='static/'
STATICFILES_DIRS=[BASE_DIR/'static']
STATIC_ROOT=BASE_DIR/'staticfiles'
DEFAULT_AUTO_FIELD='django.db.models.BigAutoField'
LOGIN_URL='login'
LOGIN_REDIRECT_URL='dashboard'
LOGOUT_REDIRECT_URL='login'
SESSION_COOKIE_HTTPONLY=True
SESSION_COOKIE_SAMESITE='Lax'
CSRF_COOKIE_SAMESITE='Lax'
X_FRAME_OPTIONS='DENY'

# User-uploaded profile photos. Always store these on the persistent EC2 volume.
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'
