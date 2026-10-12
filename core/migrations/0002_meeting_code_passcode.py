from django.db import migrations, models
import secrets, string

def backfill(apps, schema_editor):
    Meeting=apps.get_model('core','Meeting')
    alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    used=set(Meeting.objects.exclude(meeting_code__isnull=True).values_list('meeting_code',flat=True))
    for m in Meeting.objects.all():
        if not m.meeting_code:
            while True:
                code=''.join(secrets.choice(string.digits) for _ in range(11))
                if code not in used:
                    used.add(code); break
            m.meeting_code=code
        if not m.passcode:
            m.passcode=''.join(secrets.choice(alphabet) for _ in range(6))
        m.save(update_fields=['meeting_code','passcode'])

class Migration(migrations.Migration):
    dependencies=[('core','0001_initial')]
    operations=[
        migrations.AddField(model_name='meeting',name='meeting_code',field=models.CharField(blank=True,max_length=16,null=True,unique=True)),
        migrations.AddField(model_name='meeting',name='passcode',field=models.CharField(blank=True,max_length=12)),
        migrations.RunPython(backfill,migrations.RunPython.noop),
    ]
