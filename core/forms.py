from django import forms
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User
from django.utils import timezone
class SignUpForm(UserCreationForm):
    email=forms.EmailField(required=True)
    first_name=forms.CharField(max_length=50,required=True,label='Full name')
    class Meta:
        model=User; fields=['first_name','username','email','password1','password2']
    def save(self,commit=True):
        u=super().save(commit=False);u.email=self.cleaned_data['email']
        if commit:u.save()
        return u
class MeetingScheduleForm(forms.Form):
    title=forms.CharField(max_length=120,initial='NexaRoom Meeting')
    scheduled_for=forms.DateTimeField(widget=forms.DateTimeInput(attrs={'type':'datetime-local'}),input_formats=['%Y-%m-%dT%H:%M'])
    def clean_scheduled_for(self):
        v=self.cleaned_data['scheduled_for']
        if v<=timezone.now(): raise forms.ValidationError('Choose a future date and time.')
        return v


from .models import UserProfile
from PIL import Image, UnidentifiedImageError

class AccountProfileForm(forms.Form):
    full_name = forms.CharField(max_length=100, label='Full name')
    email = forms.EmailField(label='Email address')
    photo = forms.ImageField(required=False, label='Profile photo', help_text='JPG or PNG, up to 3 MB')
    remove_photo = forms.BooleanField(required=False)

    def clean_photo(self):
        f = self.cleaned_data.get('photo')
        if not f:
            return f
        if f.size > 3 * 1024 * 1024:
            raise forms.ValidationError('Choose a photo smaller than 3 MB.')
        if f.content_type not in ('image/jpeg', 'image/png'):
            raise forms.ValidationError('Only JPG and PNG images are accepted.')
        try:
            image = Image.open(f)
            image.verify()
            if image.format not in ('JPEG', 'PNG'):
                raise ValueError('Unsupported image format')
        except (UnidentifiedImageError, OSError, ValueError):
            raise forms.ValidationError('The uploaded file is not a valid image.')
        finally:
            f.seek(0)
        return f
