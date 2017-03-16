#!flask/bin/python
import urllib2
from OpenSSL import SSL
from bs4 import BeautifulSoup as bs
import re
import pandas as pd
import pymysql
from datetime import datetime
from dateutil.parser import parse

password = 'Eranu2304'
conn = pymysql.connect(host='127.0.0.1', unix_socket='/tmp/mysql.sock', user='root', passwd=password, db='bm_scraping', charset='utf8')
cur = conn.cursor()
cur.execute("USE bm_scraping")

def open_https(url):
    try: 
        response = urllib2.urlopen(url)  
        print 'response headers: "%s"' % response.info() 
        page = response.read()
    except IOError, e: 
        if hasattr(e, 'code'): # HTTPError 
            print 'http error code: ', e.code 
        elif hasattr(e, 'reason'): # URLError 
            print "can't connect, reason: ", e.reason 
        else: 
            raise
    return page

to_parse = set()

def addUrlifnotexists(url):
    cur.execute("SELECT * FROM parsed_links WHERE link = %s", (url))
    if cur.rowcount == 0:
        date = datetime.now()
        cur.execute("INSERT INTO parsed_links (date, link) VALUES (%s, %s)", (date, url))
        to_parse.add(url)
        cur.connection.commit()
        return cur.lastrowid
    else:
        return cur.fetchone()[0]

def store_paid(title, link, date, price):
    print("Processing: ", title)
    print("Processing: ", link)
    print("Processing: ", date)
    print("Processing: ", price)
    cur.execute("INSERT INTO paid_articles (title, link, date, price) VALUES (%s,%s,%s,%s)", (title, link, date, price))
    cur.connection.commit()
    
def store_free(title, link, date):
    cur.execute("INSERT INTO free_articles (title, link, date) VALUES (%s,%s,%s)", (title, link, date))
    cur.connection.commit()

#This function can be made recursive by uncommenting the last line            
def getLinks(page_url):
    html = open_https(page_url)
    bsObj = bs(html, "html.parser")
    #try:
    #     print(bsObj.h1.get_text())
    #except AttributeError as e:
    #     print(e)
    for link in bsObj.find_all("a", href=re.compile("https://businessmontres.com/article/")):
         if 'href' in link.attrs:
            newPage = link.attrs['href']
            #print("------------------\n"+newPage)
            addUrlifnotexists(newPage)
            #getLinks(newPage)

getLinks("https://www.businessmontres.com")

def get_data(link):
    page = open_https(link)
    soup = bs(page)
    date = soup.find_all("span", class_="entry-author")
    date = date[0].get_text()
    date = date.encode('ascii', 'ignore')
    date = date.replace("Le ", "")
    date = date.replace(" / ", "/")
    date = date.split(" ")
    publish_date = date[0]
    #publish_date = parse(date).strftime("%Y-%m-%d")
    publish_date = datetime.strptime(publish_date, "%d/%m/%Y").strftime("%Y-%m-%d")
    #publish_date = parse(publish_date).strftime("%Y-%m-%d")
    #publish_date = publish_date.date().isoformat()
    publish_time = date[1]
    title = soup.find("h1", class_="entry-title")
    title = title.get_text()
    price = soup.find_all("div", class_="col-md-6 col-sm-12 col-xs-12")
    if len(price)>0:
        price = price[1].get_text()
        price = str(price).replace("Acheter cet article pour"," ")
        price = str(price).replace("seulement"," ")
        price = str(price).replace("CHF", "")
        price = str(price).replace(" ", "")
        price = str(price).replace("\n", "")
        price = float(price)
    else:
        price = 0
    if price > 0:
        store_paid(title, link, publish_date, price)
    else:
        store_free(title, link, publish_date)
        
for link in to_parse:
    get_data(link)

cur.close()
conn.close()
    

