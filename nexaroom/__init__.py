import os

if os.getenv('DB_ENGINE','mysql').lower() != 'sqlite':
    import pymysql
    pymysql.install_as_MySQLdb()
