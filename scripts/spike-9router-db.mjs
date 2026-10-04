import D from '../node_modules/better-sqlite3/lib/index.js'
import fs from 'node:fs'

const dir = process.env.APPDATA + '/9router/db'
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.sqlite')) continue
  try {
    const d = new D(dir + '/' + f, { readonly: true })
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    console.log(f, 'tables:', tables.join(', '))
    for (const t of tables.filter((x) => /key|token|auth|user|account|setting/i.test(x))) {
      const cols = d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      const n = d.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
      console.log('  *', t, `(${n} rows):`, cols.join(','))
    }
    d.close()
  } catch (e) {
    console.log(f, 'ERR', e.message)
  }
}
