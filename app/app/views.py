from os import path
from flask import render_template, send_file, flash, redirect, session, url_for, request, g
from flask_login import login_user, logout_user, current_user, login_required
from app import app, db, lm, oid
from .forms import LoginForm
from .models import User
import pymysql
import pandas as pd
import matplotlib
matplotlib.use('PS') 
from matplotlib import pyplot as plt
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas
from matplotlib.figure import Figure
from wordcloud import WordCloud, STOPWORDS
import base64
from io import BytesIO

@lm.user_loader
def load_user(id):
    return User.query.get(int(id))
    
@app.before_request
def before_request():
	g.user = current_user

@app.route('/')
@app.route('/index')
##@login_required
def index():
    user = g.user
    posts = [
    	{
    		'author': {'nickname': 'admin'},
    		'body': 'Le baromontres'
    	},
    	{	'author': {'nickname': 'admin'},
    		'body': 'Lets mots'
    	}
    ]
    return render_template('index.html',
    						title = 'Home',
    						user=user,
    						posts= posts)


@app.route('/login', methods=['GET', 'POST'])
###@oid.loginhandler
def login():
    ###if g.user is not None and g.user.is_authenticated:
    ###	return redirect('index.html')
	form = LoginForm()
	if form.validate_on_submit():
		session['remember_me'] = form.remember_me.data
		return oid.try_login(form.openid.data, ask_for=['nickname', 'email'])
	return render_template('login.html',
							title='Baromontres - login',
							)


@oid.after_login
def after_login(resp):
    if resp.email is None or resp.email == "":
        flash('Invalid login. Please try again.')
        return redirect(url_for('login'))
    user = User.query.filter_by(email=resp.email).first()
    if user is None:
        nickname = resp.nickname
        if nickname is None or nickname == "":
            nickname = resp.email.split('@')[0]
        user = User(nickname=nickname, email=resp.email)
        db.session.add(user)
        db.session.commit()
    remember_me = False
    if 'remember_me' in session:
        remember_me = session['remember_me']
        session.pop('remember_me', None)
    login_user(user, remember = remember_me)
    return redirect(request.args.get('next') or url_for('index'))
    
@app.route('/chart')
def chart():
	password = 'Eranu2304'
	conn = pymysql.connect(host='127.0.0.1', unix_socket='/tmp/mysql.sock', user='root', passwd=password, db='bm_scraping', charset='utf8')
	cur = conn.cursor()
	cur.execute('SELECT date, price from paid_articles');
	rows = []
	for row in cur:
		rows.append(row)
	df = pd.DataFrame(rows)
	labels = df[0]
	values = df[1]
	start_date = df[0].iloc[0]
	end_date = df[0].iloc[-1]
	average_price = round(sum(values)/len(values),2)
	conn.close()
	return render_template('chart.html',
							title='Baromontres - courbe de prix',
							values= values,
							labels=labels,
							start_date = start_date,
							end_date = end_date,
							average_price = average_price
							)
							
@app.route('/cloud')
def cloud():
	password = 'Eranu2304'
	conn = pymysql.connect(host='127.0.0.1', unix_socket='/tmp/mysql.sock', user='root', passwd=password, db='bm_scraping', charset='utf8')
	cur = conn.cursor()
	cur.execute('SELECT link from paid_articles');
	corpus = []
	for row in cur:
		text = row[0]
		text = text.strip("https://businessmontres.com/article/")
		text = text.replace("-", " ")
		for word in text.split():
			corpus.append(word)
	cloud_base = ''.join(corpus)		
	conn.close()
	#stopwords = set(STOPWORDS)
	stopwords = ["le", "de", "et", "la", "pour", "qui", "un", "une", "dans", "du", "de", "cest", "les", "des", "ce", "se", "en", "quand", "sur"]
	wc = WordCloud(max_words=300, stopwords=stopwords)
	wc.generate(cloud_base)
	plt.imshow(wc)
	return render_template("cloud.html")
