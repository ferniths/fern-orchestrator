import Database from 'better-sqlite3'

const db = new Database(':memory:')
db.exec('CREATE VIRTUAL TABLE t USING fts5(x)')
db.prepare('INSERT INTO t VALUES (?)').run('hello world')
const hits = db.prepare("SELECT * FROM t WHERE t MATCH 'hello'").all()
const v = db.prepare('SELECT sqlite_version() AS v').get()
console.log('OK sqlite', v.v, 'fts5 hits', hits.length, 'node', process.version)
db.close()
