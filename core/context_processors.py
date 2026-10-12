def brand_context(request):
    photo_url = ''
    if request.user.is_authenticated:
        try:
            profile = request.user.nexa_profile
            if profile.photo:
                photo_url = profile.photo.url
        except Exception:
            pass
    return {'APP_NAME':'NexaRoom-GV','APP_TAGLINE':'Meet. Share. Collaborate.','account_photo_url':photo_url}
