from django.urls import include,path
from core.admin import nexaroom_admin_site
urlpatterns=[path('admin/',nexaroom_admin_site.urls),path('',include('core.urls'))]
