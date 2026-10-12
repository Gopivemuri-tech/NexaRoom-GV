from django.contrib import admin
from django.contrib.auth.models import User,Group
from django.contrib.auth.admin import UserAdmin,GroupAdmin
from .models import Plan,Subscription,Meeting,MeetingParticipant,SharedFile,AppSetting,AuditLog
class Site(admin.AdminSite):site_header='NexaRoom Administration';site_title='NexaRoom Admin';index_title='Control Center'
nexaroom_admin_site=Site(name='nexaroom_admin');nexaroom_admin_site.register(User,UserAdmin);nexaroom_admin_site.register(Group,GroupAdmin)
for model in [Plan,Subscription,Meeting,MeetingParticipant,SharedFile,AppSetting,AuditLog]:nexaroom_admin_site.register(model)
