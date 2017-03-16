import os
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_openid import OpenID
from config import basedir


app = Flask(__name__)
lm = LoginManager()
lm.init_app(app)
lm.login_view = 'login'
oid = OpenID(app, os.path.join(basedir, 'tmp'))
app.config.from_object('config')
app.config['OAUTH_CREDENTIALS'] = {
    'facebook': {
        'id': '777576832392961',
        'secret': '15ba2519ceaa1426c45f5585c5af347e'
    }
}

db = SQLAlchemy(app)

from app import views, models