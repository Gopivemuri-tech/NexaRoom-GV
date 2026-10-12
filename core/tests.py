from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from datetime import timedelta
from .models import Plan,Meeting
from .services import seed_defaults,ensure_subscription
class BackendTests(TestCase):
 def setUp(self):
  seed_defaults();self.u=User.objects.create_user(username='gopi',password='StrongPass123!');ensure_subscription(self.u)
 def test_plans(self): self.assertEqual(Plan.objects.count(),3)
 def test_dashboard_requires_login(self): self.assertEqual(self.client.get(reverse('dashboard')).status_code,302)
 def test_create_meeting(self):
  self.client.login(username='gopi',password='StrongPass123!');r=self.client.post(reverse('create_meeting'),{'title':'Team Sync'});self.assertEqual(r.status_code,302);self.assertTrue(Meeting.objects.filter(host=self.u,title='Team Sync').exists())
 def test_schedule(self):
  self.client.login(username='gopi',password='StrongPass123!');future=(timezone.now()+timedelta(days=1)).strftime('%Y-%m-%dT%H:%M');self.client.post(reverse('schedule_meeting'),{'title':'Tomorrow','scheduled_for':future});self.assertTrue(Meeting.objects.filter(title='Tomorrow',status='scheduled').exists())


class NexaRoomMeetingCodeTests(TestCase):
    def setUp(self):
        seed_defaults()
        self.user=User.objects.create_user(username='roomuser',password='StrongPass123!')
        ensure_subscription(self.user)
        self.client.login(username='roomuser',password='StrongPass123!')

    def test_meeting_code_and_passcode_generated(self):
        self.client.post(reverse('create_meeting'),{'title':'Code Test'})
        m=Meeting.objects.get(host=self.user)
        self.assertEqual(len(m.meeting_code),11)
        self.assertEqual(len(m.passcode),6)

    def test_join_by_meeting_code_and_passcode(self):
        other=User.objects.create_user(username='hostx',password='StrongPass123!')
        ensure_subscription(other)
        m=Meeting.objects.create(host=other,title='Join Test',status='live',started_at=timezone.now())
        response=self.client.get(reverse('join_meeting'),{'invite':m.meeting_code_display,'passcode':m.passcode})
        self.assertEqual(response.status_code,302)
        self.assertIn(str(m.id),response['Location'])

class PersistenceRegressionTests(TestCase):
    def setUp(self):
        seed_defaults()
        self.staff=User.objects.create_user(username='adminx',password='StrongPass123!',is_staff=True)
        ensure_subscription(self.staff)
        self.client.login(username='adminx',password='StrongPass123!')

    def test_plan_ui_changes_survive_seed_defaults(self):
        plan=Plan.objects.get(code='free')
        self.client.post(reverse('control_update_plan',args=[plan.id]),{
            'meeting_minutes':'55','max_participants':'9','max_file_mb':'15','video_quality':'1080p',
            'screen_share':'on','whiteboard':'on','recording':'on'
        })
        seed_defaults()
        plan.refresh_from_db()
        self.assertEqual(plan.meeting_minutes,55)
        self.assertEqual(plan.max_participants,9)
        self.assertEqual(plan.max_file_mb,15)
        self.assertEqual(plan.video_quality,'1080p')
        self.assertTrue(plan.recording)

    def test_join_link_keeps_secure_key(self):
        host=User.objects.create_user(username='invitehost',password='StrongPass123!')
        ensure_subscription(host)
        m=Meeting.objects.create(host=host,title='Invite Test',status='live',started_at=timezone.now())
        response=self.client.get(reverse('join_meeting'),{'invite':m.meeting_code,'passcode':m.passcode,'k':'abc_DEF-123'})
        self.assertEqual(response.status_code,302)
        self.assertIn(str(m.id),response['Location'])
        self.assertTrue(response['Location'].endswith('#k=abc_DEF-123'))

class NexaRoomGVUpgradeTests(TestCase):
    def setUp(self):
        from .invitations import create_invitation
        self.host = User.objects.create_user(username='hostv9',password='StrongPass123!')
        self.guest = User.objects.create_user(username='guestv9',password='StrongPass123!')
        seed_defaults()
        ensure_subscription(self.host)
        ensure_subscription(self.guest)
        self.room = Meeting.objects.create(host=self.host,title='The original room',status='live',started_at=timezone.now(),locked=True)
        self.token = create_invitation(self.room)

    def test_locked_invitation_reuses_room_without_creating_new_one(self):
        self.client.force_login(self.guest)
        old_count = Meeting.objects.count()
        r = self.client.get(reverse('join_meeting'), {
            'invite':self.room.meeting_code,'passcode':self.room.passcode,'token':self.token,'k':'secure-room-key'
        })
        self.assertEqual(r.status_code,302)
        self.assertIn(str(self.room.id),r['Location'])
        self.assertIn('token=',r['Location'])
        self.assertIn('#k=secure-room-key',r['Location'])
        self.assertEqual(Meeting.objects.count(),old_count)
        page=self.client.get(r['Location'])
        self.assertEqual(page.status_code,200)
        self.assertContains(page,'inviteToken:')

    def test_locked_join_without_valid_invitation_does_not_create_meeting(self):
        self.client.force_login(self.guest)
        prior=Meeting.objects.count()
        r=self.client.get(reverse('join_meeting'),{'invite':self.room.meeting_code,'passcode':self.room.passcode})
        self.assertRedirects(r,reverse('meetings'),fetch_redirect_response=False)
        self.assertEqual(Meeting.objects.count(),prior)
        r=self.client.get(reverse('meeting_room',kwargs={'meeting_id':self.room.id}))
        self.assertRedirects(r,reverse('meetings'),fetch_redirect_response=False)

    def test_invite_cannot_be_used_for_different_room(self):
        from .invitations import is_valid_invitation
        other=Meeting.objects.create(host=self.host,title='Different',status='live',locked=True)
        self.assertFalse(is_valid_invitation(other.id,self.token))
        self.assertTrue(is_valid_invitation(self.room.id,self.token))

    def test_first_signup_redirects_to_same_locked_meeting(self):
        from urllib.parse import urlencode
        from django.test import Client, override_settings
        # Exercise Django CSRF checks with a reverse-proxy HTTPS origin.
        client=Client(enforce_csrf_checks=True)
        q={'invite':self.room.meeting_code,'passcode':self.room.passcode,'token':self.token,'k':'ok'}
        intended=reverse('join_meeting')+'?'+urlencode(q)
        with override_settings(CSRF_TRUSTED_ORIGINS=['https://nexaroom-gv.duckdns.org'],
                               SECURE_PROXY_SSL_HEADER=('HTTP_X_FORWARDED_PROTO','https'),
                               ALLOWED_HOSTS=['nexaroom-gv.duckdns.org']):
            resp=client.get(reverse('signup')+'?'+urlencode({'next':intended}),
                            HTTP_HOST='nexaroom-gv.duckdns.org',HTTP_X_FORWARDED_PROTO='https')
            self.assertEqual(resp.status_code,200)
            self.assertContains(resp,'name="next"')
            csrf=client.cookies['csrftoken'].value
            resp=client.post(reverse('signup')+'?'+urlencode({'next':intended}),{
                'first_name':'New Invited Guest','username':'invitedv9','email':'invited@example.org',
                'password1':'VeryStrongTest!246','password2':'VeryStrongTest!246','next':intended,
                'csrfmiddlewaretoken':csrf,
            },HTTP_HOST='nexaroom-gv.duckdns.org', HTTP_ORIGIN='https://nexaroom-gv.duckdns.org',HTTP_X_FORWARDED_PROTO='https')
            self.assertEqual(resp.status_code,302)
            self.assertTrue(User.objects.filter(username='invitedv9').exists())
            self.assertIn('/meeting/join/',resp['Location'])
            # Follow protected invite without generating any other meeting.
            r2=client.get(resp['Location'],HTTP_HOST='nexaroom-gv.duckdns.org',HTTP_X_FORWARDED_PROTO='https')
            self.assertEqual(r2.status_code,302)
            self.assertIn(str(self.room.id),r2['Location'])
            self.assertEqual(Meeting.objects.count(),1)

    def test_profile_photo_upload_and_protected_media(self):
        import io, tempfile
        from django.core.files.uploadedfile import SimpleUploadedFile
        from django.test import override_settings
        from PIL import Image
        from .models import UserProfile
        with tempfile.TemporaryDirectory() as directory, override_settings(MEDIA_ROOT=directory):
            self.client.force_login(self.guest)
            buf=io.BytesIO()
            Image.new('RGB',(48,48),(32,99,80)).save(buf,format='PNG')
            img=SimpleUploadedFile('portrait.png',buf.getvalue(),content_type='image/png')
            r=self.client.post(reverse('account_profile'),{'full_name':'Guest QA','email':'guest@example.org','photo':img})
            self.assertEqual(r.status_code,302)
            pf=UserProfile.objects.get(user=self.guest)
            self.assertTrue(pf.photo)
            self.assertTrue(pf.photo.name.startswith('nexaroom_profiles/'))
            image_url=pf.photo.url
            media_resp=self.client.get(image_url)
            self.assertEqual(media_resp.status_code,200)
            self.assertEqual(media_resp['Content-Type'],'image/png')
            self.assertContains(self.client.get(reverse('dashboard')),image_url)
            self.client.logout()
            self.assertEqual(self.client.get(image_url).status_code,302)

    def test_signaling_locked_room_allows_only_signed_invite(self):
        from core.realtime import join_info
        denied=join_info.func(str(self.room.id), self.guest.id, '')
        self.assertIn('locked',denied.get('error','').lower())
        accepted=join_info.func(str(self.room.id), self.guest.id, self.token)
        self.assertIn('pid',accepted)
        self.assertEqual(accepted['host_id'],self.host.id)
        self.assertEqual(Meeting.objects.count(),1)
