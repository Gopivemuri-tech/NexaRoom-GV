import uuid, secrets, string
from pathlib import Path
from django.conf import settings
from django.db import models
from django.utils import timezone

class Plan(models.Model):
    code=models.CharField(max_length=20,unique=True)
    name=models.CharField(max_length=50)
    price_monthly=models.DecimalField(max_digits=9,decimal_places=2,default=0)
    meeting_minutes=models.PositiveIntegerField(null=True,blank=True,help_text='Blank = unlimited')
    max_participants=models.PositiveIntegerField(default=4)
    max_file_mb=models.PositiveIntegerField(default=5)
    video_quality=models.CharField(max_length=20,default='720p')
    screen_share=models.BooleanField(default=True)
    whiteboard=models.BooleanField(default=True)
    recording=models.BooleanField(default=False)
    custom_branding=models.BooleanField(default=False)
    active=models.BooleanField(default=True)
    display_order=models.PositiveIntegerField(default=0)
    class Meta: ordering=['display_order','price_monthly']
    def __str__(self): return self.name
    @property
    def meeting_limit_label(self): return 'Unlimited' if not self.meeting_minutes else f'{self.meeting_minutes} min'

class Subscription(models.Model):
    user=models.OneToOneField(settings.AUTH_USER_MODEL,on_delete=models.CASCADE,related_name='subscription')
    plan=models.ForeignKey(Plan,on_delete=models.PROTECT,related_name='subscriptions')
    active=models.BooleanField(default=True)
    started_at=models.DateTimeField(default=timezone.now)
    expires_at=models.DateTimeField(null=True,blank=True)
    updated_at=models.DateTimeField(auto_now=True)
    def __str__(self): return f'{self.user.username} — {self.plan.name}'

class Meeting(models.Model):
    id=models.UUIDField(primary_key=True,default=uuid.uuid4,editable=False)
    meeting_code=models.CharField(max_length=16,unique=True,null=True,blank=True)
    passcode=models.CharField(max_length=12,blank=True)
    host=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.CASCADE,related_name='hosted_meetings')
    title=models.CharField(max_length=120,default='NexaRoom Meeting')
    status=models.CharField(max_length=12,choices=[('scheduled','Scheduled'),('live','Live'),('ended','Ended')],default='scheduled')
    scheduled_for=models.DateTimeField(null=True,blank=True)
    started_at=models.DateTimeField(null=True,blank=True)
    ended_at=models.DateTimeField(null=True,blank=True)
    duration_limit_minutes=models.PositiveIntegerField(null=True,blank=True)
    max_participants=models.PositiveIntegerField(default=4)
    locked=models.BooleanField(default=False)
    allow_screen_share=models.BooleanField(default=True)
    allow_whiteboard=models.BooleanField(default=True)
    allow_files=models.BooleanField(default=True)
    allow_chat=models.BooleanField(default=True)
    allow_unmute=models.BooleanField(default=True)
    allow_video=models.BooleanField(default=True)
    created_at=models.DateTimeField(auto_now_add=True)
    class Meta: ordering=['-created_at']

    def _new_code(self):
        # 11 digits, displayed like 123 4567 8901
        while True:
            code=''.join(secrets.choice(string.digits) for _ in range(11))
            if not Meeting.objects.filter(meeting_code=code).exists():
                return code

    def _new_passcode(self):
        alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        return ''.join(secrets.choice(alphabet) for _ in range(6))

    def save(self,*args,**kwargs):
        if not self.meeting_code: self.meeting_code=self._new_code()
        if not self.passcode: self.passcode=self._new_passcode()
        super().save(*args,**kwargs)

    def __str__(self): return f'{self.title} ({self.meeting_code_display})'
    @property
    def short_id(self): return self.meeting_code_display
    @property
    def meeting_code_display(self):
        c=self.meeting_code or str(self.id).split('-')[0].upper()
        return f'{c[:3]} {c[3:7]} {c[7:]}' if c.isdigit() and len(c)==11 else c

class MeetingParticipant(models.Model):
    meeting=models.ForeignKey(Meeting,on_delete=models.CASCADE,related_name='participants')
    user=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.CASCADE,related_name='meeting_participations')
    joined_at=models.DateTimeField(auto_now_add=True)
    left_at=models.DateTimeField(null=True,blank=True)
    is_host=models.BooleanField(default=False)
    class Meta: ordering=['joined_at']

class SharedFile(models.Model):
    meeting=models.ForeignKey(Meeting,on_delete=models.CASCADE,related_name='shared_files')
    sender=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.CASCADE)
    original_name=models.CharField(max_length=255)
    size_bytes=models.BigIntegerField(default=0)
    mime_type=models.CharField(max_length=120,blank=True)
    encrypted=models.BooleanField(default=True)
    shared_at=models.DateTimeField(auto_now_add=True)

class AppSetting(models.Model):
    key=models.CharField(max_length=100,unique=True)
    value=models.TextField(blank=True)
    description=models.CharField(max_length=255,blank=True)
    updated_at=models.DateTimeField(auto_now=True)
    def __str__(self): return self.key

class AuditLog(models.Model):
    user=models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.SET_NULL,null=True,blank=True)
    action=models.CharField(max_length=120)
    detail=models.TextField(blank=True)
    ip_address=models.GenericIPAddressField(null=True,blank=True)
    created_at=models.DateTimeField(auto_now_add=True)
    class Meta: ordering=['-created_at']


def user_profile_path(instance, filename):
    # A file is validated by AccountProfileForm before storage.
    ext = Path(filename).suffix.lower()
    if ext not in ('.png', '.jpg', '.jpeg'):
        ext = '.jpg'
    return f'nexaroom_profiles/{uuid.uuid4().hex}{ext}'

class UserProfile(models.Model):
    """Optional image for account header and camera-off avatars."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='nexa_profile')
    photo = models.ImageField(upload_to=user_profile_path, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'Profile: {self.user.username}'
