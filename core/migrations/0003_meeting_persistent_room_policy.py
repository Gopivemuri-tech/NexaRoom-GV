from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("core", "0002_meeting_code_passcode")]

    operations = [
        migrations.AddField(
            model_name="meeting",
            name="allow_chat",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="meeting",
            name="allow_unmute",
            field=models.BooleanField(default=True),
        ),
        migrations.AddField(
            model_name="meeting",
            name="allow_video",
            field=models.BooleanField(default=True),
        ),
    ]
