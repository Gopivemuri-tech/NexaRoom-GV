from urllib.parse import urlparse, parse_qs, quote, urlencode
import os
from django.conf import settings
from django.http import JsonResponse, HttpResponseForbidden, FileResponse, Http404
from django.utils.http import url_has_allowed_host_and_scheme
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required,user_passes_test
from django.contrib.auth.models import User
from django.shortcuts import get_object_or_404,redirect,render
from django.urls import reverse
from django.utils import timezone
from django.views.decorators.http import require_POST
from django.views.decorators.cache import never_cache
from django.views.decorators.clickjacking import xframe_options_deny
from django.views.decorators.csrf import ensure_csrf_cookie
from django.db import transaction
from .forms import SignUpForm,MeetingScheduleForm,AccountProfileForm
from .models import Meeting,Plan,Subscription,AuditLog,UserProfile
from .services import seed_defaults,ensure_subscription
from .invitations import create_invitation, is_valid_invitation

def ip(req): return req.META.get('REMOTE_ADDR')
@never_cache
@ensure_csrf_cookie
def signup_view(request):
    target = request.POST.get('next') or request.GET.get('next') or ''
    if request.user.is_authenticated:
        return redirect(target if url_has_allowed_host_and_scheme(target, allowed_hosts={request.get_host()}, require_https=request.is_secure()) else 'dashboard')
    form=SignUpForm(request.POST or None)
    if request.method=='POST' and form.is_valid():
        with transaction.atomic():
            user=form.save()
            seed_defaults()
            ensure_subscription(user)
            AuditLog.objects.create(user=user,action='register',ip_address=ip(request))
        login(request,user)
        return redirect(target if url_has_allowed_host_and_scheme(target,allowed_hosts={request.get_host()},require_https=request.is_secure()) else 'dashboard')
    return render(request,'registration/signup.html',{'form':form,'next_target':target})

@login_required
def account_profile(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    if request.method == 'POST':
        form = AccountProfileForm(request.POST, request.FILES)
        if form.is_valid():
            request.user.first_name = form.cleaned_data['full_name'].strip()
            request.user.last_name = ''
            request.user.email = form.cleaned_data['email']
            request.user.save(update_fields=['first_name','last_name','email'])
            prior_photo = profile.photo.name if profile.photo else ''
            new_photo = form.cleaned_data.get('photo')
            remove_photo = form.cleaned_data.get('remove_photo')
            if new_photo:
                profile.photo = new_photo
            elif remove_photo:
                profile.photo = ''
            profile.save()
            # Delete old media only after the new image and DB row were saved.
            if prior_photo and (new_photo or remove_photo) and prior_photo != profile.photo.name:
                profile.photo.storage.delete(prior_photo)
            messages.success(request, 'Your profile has been updated.')
            return redirect('account_profile')
    else:
        form = AccountProfileForm(initial={'full_name':request.user.get_full_name() or request.user.username,'email':request.user.email})
    return render(request,'core/account_profile.html',{'form':form,'profile':profile})

@login_required
@xframe_options_deny
def account_photo(request, filename):
    # Restrict media routing to uploaded profile images; never serve arbitrary files.
    if not filename or not filename.lower().endswith(('.jpg', '.jpeg', '.png')):
        raise Http404
    profile = UserProfile.objects.filter(photo='nexaroom_profiles/'+filename).first()
    if not profile or not profile.photo:
        raise Http404
    try:
        handle = profile.photo.open('rb')
    except (OSError, ValueError, FileNotFoundError):
        raise Http404
    content_type = 'image/png' if filename.lower().endswith('.png') else 'image/jpeg'
    response = FileResponse(handle, content_type=content_type)
    response['Cache-Control'] = 'private, max-age=3600'
    response['X-Content-Type-Options'] = 'nosniff'
    return response

@login_required
def dashboard(request):
    seed_defaults();sub=ensure_subscription(request.user)
    return render(request,'core/dashboard.html',{'subscription':sub,'recent_meetings':Meeting.objects.filter(host=request.user)[:6]})
@login_required
@require_POST
def create_meeting(request):
    sub=ensure_subscription(request.user);title=request.POST.get('title','').strip() or 'NexaRoom Meeting'
    m=Meeting.objects.create(host=request.user,title=title,status='live',started_at=timezone.now(),duration_limit_minutes=sub.plan.meeting_minutes,max_participants=sub.plan.max_participants,allow_screen_share=sub.plan.screen_share,allow_whiteboard=sub.plan.whiteboard,allow_files=True)
    AuditLog.objects.create(user=request.user,action='meeting_create',detail=str(m.id),ip_address=ip(request));return redirect('meeting_room',meeting_id=m.id)
@login_required
@require_POST
def schedule_meeting(request):
    form=MeetingScheduleForm(request.POST)
    if form.is_valid():
        sub=ensure_subscription(request.user);m=Meeting.objects.create(host=request.user,title=form.cleaned_data['title'],status='scheduled',scheduled_for=form.cleaned_data['scheduled_for'],duration_limit_minutes=sub.plan.meeting_minutes,max_participants=sub.plan.max_participants,allow_screen_share=sub.plan.screen_share,allow_whiteboard=sub.plan.whiteboard,allow_files=True);messages.success(request,'Meeting scheduled.');return redirect('meeting_room',meeting_id=m.id)
    messages.error(request,'Please check the schedule details.');return redirect('dashboard')
@login_required
def join_meeting(request):
    raw=request.GET.get('invite','').strip()
    passcode=request.GET.get('passcode','').strip()
    room_key=request.GET.get('k','').strip()
    invite_token=request.GET.get('token','').strip()
    room=raw
    fragment=''

    # Accept Meeting ID/code, a legacy /meet/<uuid>/ URL, or the new one-click
    # /meeting/join/?invite=...&passcode=...&k=... invite URL.
    if raw.startswith(('http://','https://')):
        try:
            parsed=urlparse(raw)
            fragment=parsed.fragment
            q=parse_qs(parsed.query)
            if '/meeting/join/' in parsed.path and q.get('invite'):
                room=q.get('invite',[''])[0]
                passcode=passcode or q.get('passcode',[''])[0]
                room_key=room_key or q.get('k',[''])[0]
                invite_token=invite_token or q.get('token',[''])[0]
            else:
                parts=[part for part in parsed.path.split('/') if part]
                room=parts[parts.index('meet')+1] if 'meet' in parts and parts.index('meet')+1 < len(parts) else ''
                if fragment.startswith('k=') and not room_key:
                    room_key=fragment[2:]
        except Exception:
            room=''

    clean=''.join(ch for ch in room if ch.isalnum() or ch=='-')
    m=None
    try:
        m=Meeting.objects.get(id=clean)
    except Exception:
        digits=''.join(ch for ch in room if ch.isdigit())
        if digits:
            m=Meeting.objects.filter(meeting_code=digits).first()

    if not m:
        messages.error(request,'Meeting not found. Check the invite link or Meeting ID.')
        return redirect('dashboard')

    # One-click links carry the passcode. Manual Meeting-ID joins still require it.
    if m.passcode and passcode and passcode.upper()!=m.passcode.upper():
        messages.error(request,'Incorrect meeting passcode.')
        return redirect('dashboard')
    if m.passcode and not passcode and not raw.startswith(('http://','https://')):
        messages.error(request,'Enter the meeting passcode.')
        return redirect('dashboard')

    if m.status == 'ended':
        messages.error(request, 'This meeting has ended.')
        return redirect('meetings')
    if m.locked and m.host_id != request.user.id and not is_valid_invitation(m.id, invite_token):
        messages.error(request, 'This meeting is locked. Ask the host for a new invitation link.')
        return redirect('meetings')
    target=reverse('meeting_room',kwargs={'meeting_id':m.id})
    if invite_token and is_valid_invitation(m.id, invite_token):
        target += '?' + urlencode({'token': invite_token})
    if room_key:
        target += '#k='+quote(room_key,safe='-_')
    elif fragment:
        target += '#'+fragment
    return redirect(target)
def _meeting_ice_servers():
    servers=[{'urls':['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]
    turn_url=os.getenv('NEXAROOM_TURN_URL','').strip()
    turn_user=os.getenv('NEXAROOM_TURN_USERNAME','').strip()
    turn_key=os.getenv('NEXAROOM_TURN_CREDENTIAL','').strip()
    if turn_url and turn_user and turn_key:
        servers.append({'urls':turn_url,'username':turn_user,'credential':turn_key})
    return servers

@login_required
def meeting_room(request,meeting_id):
    m=get_object_or_404(Meeting,id=meeting_id)
    if m.status=='ended':return render(request,'core/meeting_ended.html',{'meeting':m})
    invite_token = request.GET.get('token','').strip()
    authorized = is_valid_invitation(m.id, invite_token)
    if m.locked and m.host_id != request.user.id and not authorized:
        messages.error(request, 'This meeting is locked. Request a fresh invitation from its host.')
        return redirect('meetings')
    if m.status=='scheduled' and m.scheduled_for and m.scheduled_for>timezone.now() and m.host_id!=request.user.id:return render(request,'core/waiting_room.html',{'meeting':m})
    if m.status=='scheduled':m.status='live';m.started_at=timezone.now();m.save(update_fields=['status','started_at'])
    base_url=getattr(settings,'NEXAROOM_PUBLIC_BASE_URL','').strip().rstrip('/') or request.build_absolute_uri('/').rstrip('/')
    return render(request,'core/meeting_room.html',{'meeting':m,'plan':ensure_subscription(request.user).plan,'is_host':m.host_id==request.user.id,'public_base_url':base_url,'ice_servers':_meeting_ice_servers(),'invite_token':create_invitation(m) if m.host_id == request.user.id else (invite_token if authorized else ''),'avatar_url':(request.user.nexa_profile.photo.url if hasattr(request.user,'nexa_profile') and request.user.nexa_profile.photo else '')})
@login_required
def plans(request):
    seed_defaults();return render(request,'core/plans.html',{'plans':Plan.objects.filter(active=True),'subscription':ensure_subscription(request.user)})

@login_required
def buy_plan(request,plan_id):
    seed_defaults()
    plan=get_object_or_404(Plan,id=plan_id,active=True)
    current=ensure_subscription(request.user)
    return render(request,'core/buy_plan.html',{'plan':plan,'subscription':current})

@login_required
def meetings(request):
    return render(request,'core/meetings.html',{'hosted':Meeting.objects.filter(host=request.user),'joined':Meeting.objects.filter(participants__user=request.user).exclude(host=request.user).distinct()})
staff_required=user_passes_test(lambda u:u.is_active and u.is_staff)
@staff_required
def control_center(request):
    seed_defaults();stats={'users':User.objects.count(),'meetings':Meeting.objects.count(),'live':Meeting.objects.filter(status='live').count(),'subscriptions':Subscription.objects.filter(active=True).count()}
    return render(request,'control/dashboard.html',{'stats':stats,'plans':Plan.objects.all(),'live_meetings':Meeting.objects.filter(status='live')[:20],'recent_users':User.objects.order_by('-date_joined')[:10]})
@staff_required
@require_POST
def control_update_plan(request,plan_id):
    p=get_object_or_404(Plan,id=plan_id);mins=request.POST.get('meeting_minutes','').strip();p.meeting_minutes=int(mins) if mins else None;p.max_participants=max(2,int(request.POST.get('max_participants',p.max_participants)));p.max_file_mb=max(1,int(request.POST.get('max_file_mb',p.max_file_mb)));p.video_quality=request.POST.get('video_quality',p.video_quality);p.screen_share='screen_share' in request.POST;p.whiteboard='whiteboard' in request.POST;p.recording='recording' in request.POST;p.custom_branding='custom_branding' in request.POST;p.save();messages.success(request,f'{p.name} updated.');return redirect('control_center')
@staff_required
@require_POST
def control_assign_plan(request,user_id):
    u=get_object_or_404(User,id=user_id);p=get_object_or_404(Plan,id=request.POST.get('plan_id'));s=ensure_subscription(u);s.plan=p;s.save();return redirect('control_center')
@staff_required
@require_POST
def control_end_meeting(request,meeting_id):
    m=get_object_or_404(Meeting,id=meeting_id);m.status='ended';m.ended_at=timezone.now();m.save(update_fields=['status','ended_at']);return redirect('control_center')

@login_required
def meeting_state_api(request,meeting_id):
    m=get_object_or_404(Meeting,id=meeting_id)
    return JsonResponse({'status':m.status})

@login_required
@require_POST
def end_meeting_api(request,meeting_id):
    m=get_object_or_404(Meeting,id=meeting_id)
    if m.host_id != request.user.id:
        return HttpResponseForbidden('Only the host can end this meeting.')
    if m.status != 'ended':
        m.status='ended'
        m.ended_at=timezone.now()
        m.save(update_fields=['status','ended_at'])
        m.participants.filter(left_at__isnull=True).update(left_at=timezone.now())
        AuditLog.objects.create(user=request.user,action='meeting_end',detail=str(m.id),ip_address=ip(request))
    return JsonResponse({'ok':True,'status':'ended'})
