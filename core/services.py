from django.db import transaction
from .models import Plan,Subscription,AppSetting
DEFAULT_PLANS=[
 dict(code='free',name='Free',price_monthly=0,meeting_minutes=40,max_participants=4,max_file_mb=5,video_quality='720p',screen_share=True,whiteboard=True,recording=False,custom_branding=False,display_order=1),
 dict(code='pro',name='Pro',price_monthly=499,meeting_minutes=None,max_participants=25,max_file_mb=25,video_quality='1080p',screen_share=True,whiteboard=True,recording=True,custom_branding=False,display_order=2),
 dict(code='business',name='Business',price_monthly=1499,meeting_minutes=None,max_participants=100,max_file_mb=100,video_quality='1080p',screen_share=True,whiteboard=True,recording=True,custom_branding=True,display_order=3),
]
@transaction.atomic
def seed_defaults():
    # Seed only missing records. Never overwrite values changed from the UI/admin.
    for x in DEFAULT_PLANS:
        defaults={k:v for k,v in x.items() if k!='code'}
        Plan.objects.get_or_create(code=x['code'],defaults=defaults)
    for k,v,d in [('brand_name','NexaRoom','Brand'),('default_plan','free','Default plan'),('support_email','support@nexaroom.local','Support')]:
        AppSetting.objects.get_or_create(key=k,defaults={'value':v,'description':d})
def ensure_subscription(user):
    try:return user.subscription
    except Subscription.DoesNotExist:
        plan=Plan.objects.filter(code='free').first()
        if not plan: seed_defaults(); plan=Plan.objects.get(code='free')
        return Subscription.objects.create(user=user,plan=plan)
