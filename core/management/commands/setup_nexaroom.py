import os,pymysql
from django.conf import settings
from django.contrib.auth.models import User
from django.core.management import BaseCommand,call_command
from core.services import seed_defaults,ensure_subscription
class Command(BaseCommand):
    help='Create nexaroom DB, migrate, seed plans/settings and create admin.'
    def handle(self,*args,**kwargs):
        if settings.DATABASES['default']['ENGINE'].endswith('sqlite3'):
            self.stdout.write(self.style.WARNING('SQLite mode: skipping MySQL database creation.'))
        else:
            db=settings.DATABASES['default'];conn=pymysql.connect(host=db['HOST'],port=int(db['PORT']),user=db['USER'],password=db['PASSWORD'],charset='utf8mb4',autocommit=True)
            with conn.cursor() as cur:cur.execute(f"CREATE DATABASE IF NOT EXISTS `{db['NAME']}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            conn.close();self.stdout.write(self.style.SUCCESS(f"Database `{db['NAME']}` ready."))
        call_command('migrate',interactive=False);seed_defaults()
        username=os.getenv('NEXAROOM_ADMIN_USERNAME','admin');email=os.getenv('NEXAROOM_ADMIN_EMAIL','admin@nexaroom.local');password=os.getenv('NEXAROOM_ADMIN_PASSWORD','Admin@12345')
        u,created=User.objects.get_or_create(username=username,defaults={'email':email,'is_staff':True,'is_superuser':True})
        u.email=email;u.is_staff=True;u.is_superuser=True
        if created:u.set_password(password)
        u.save();ensure_subscription(u)
        self.stdout.write(self.style.SUCCESS('NexaRoom setup complete.'))
        self.stdout.write(f'Admin: {username} / {password}')
