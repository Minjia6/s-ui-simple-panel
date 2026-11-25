// Local CRUD backend for the simplified S-UI panel.
// No external dependencies; records are persisted to data.json in this folder.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const configBuilder = require('./config')

const ROOT = __dirname
const DATA_FILE = path.join(ROOT, 'data.json')
const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '127.0.0.1'
const COLLECTIONS = ['inbounds', 'clients', 'outbounds', 'tls']
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function seedData() {
  return {
    inbounds: [
      { id: crypto.randomUUID(), tag: 'vless-inbound', type: 'vless', listen: '0.0.0.0', port: 443, tls: true, online: true },
      { id: crypto.randomUUID(), tag: 'mixed-local', type: 'mixed', listen: '0.0.0.0', port: 1080, tls: false, online: false }
    ],
    clients: [
      { id: crypto.randomUUID(), name: 'alice', inbound: 'vless-inbound', quota: '10 GB', expiry: '2027-01-01', online: true },
      { id: crypto.randomUUID(), name: 'bob', inbound: 'mixed-local', quota: '不限量', expiry: '2027-06-01', online: false }
    ],
    outbounds: [
      { id: crypto.randomUUID(), tag: 'direct-direct', type: 'direct', server: '127.0.0.1', port: 0, online: true },
      { id: crypto.randomUUID(), tag: 'proxy-local', type: 'socks', server: '127.0.0.1', port: 7890, online: true }
    ],
    tls: [
      {
        id: crypto.randomUUID(),
        name: '示例 TLS',
        mode: 'manual',
        modeLabel: '手动证书 / 私钥',
        sni: 'localhost',
        providerTag: '-',
        domains: '',
        hasCert: true,
        certificate: [],
        key: []
      }
    ]
  }
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const base = seedData()
    for (const collection of COLLECTIONS) {
      if (Array.isArray(parsed[collection])) base[collection] = parsed[collection]
    }
    return base
  } catch (error) {
    return seedData()
  }
}

let db = loadData()

function persist() {
  const tmp = DATA_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, DATA_FILE)
  fs.chmodSync(DATA_FILE, 0o600)
}

function sanitizeRecord(input) {
  if (!input || typeof input !== 'object') return {}
  if (Array.isArray(input)) return input.map(sanitizeRecord)
  const record = {}
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED_KEYS.has(key)) continue
    record[key] = value && typeof value === 'object' ? sanitizeRecord(value) : value
  }
  return record
}

function sameOriginWriteAllowed(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true
  if (!req.headers.origin) return true
  try {
    return new URL(req.headers.origin).host === req.headers.host
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(Object.assign(new Error('JSON 请求体格式错误'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function validate(collection, record) {
  if (collection === 'clients') {
    if (!record.name || !String(record.name).trim()) return '客户端名称不能为空'
    if (!record.inbound || !String(record.inbound).trim()) return '所属入站不能为空'
  }
  if (collection === 'tls') {
    if (!record.name || !String(record.name).trim()) return 'TLS 名称不能为空'
  }
  const errors = configBuilder.validateRecord(collection, record)
  return errors.length ? errors[0] : null
}

function requestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http')
  return `${proto}://${req.headers.host}`
}

function publicPath(urlPath) {
  try {
    const decoded = decodeURIComponent(urlPath.split('?')[0])
    const resolved = path.normalize(path.join(ROOT, decoded))
    const rootReal = fs.realpathSync(ROOT)
    const fileReal = fs.realpathSync(resolved)
    return fileReal === rootReal || fileReal.startsWith(rootReal + path.sep) ? fileReal : null
  } catch {
    return null
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file',
  '.json': 'application/json; charset=utf-8'
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const parts = url.pathname.split('/').filter(Boolean)

  if (parts[0] === 'api') {
    if (req.method === 'GET' && parts[1] === 'state' && !parts[2]) {
      return sendJson(res, 200, db)
    }

    if (!sameOriginWriteAllowed(req)) {
      return sendJson(res, 403, { error: '跨来源写请求被拒绝' })
    }

    if (req.method === 'GET' && parts[1] === 'config' && parts[2] === 'export') {
      return sendJson(res, 200, configBuilder.buildConfig(db))
    }

    if (req.method === 'GET' && parts[1] === 'subscription' && parts[2] === 'links') {
      const subscription = configBuilder.buildSubscription(db)
      const subToken = process.env.SUB_TOKEN || ''
      const tokenQuery = subToken ? `?token=${encodeURIComponent(subToken)}` : ''
      return sendJson(res, 200, { ...subscription, url: `${requestBaseUrl(req)}/sub${tokenQuery}` })
    }

    if (req.method === 'GET' && parts[1] === 'keypairs') {
      if (url.searchParams.get('k') === 'reality') return sendJson(res, 200, configBuilder.realityKeypair())
      return sendJson(res, 400, { error: '当前仅支持 Reality 密钥对生成' })
    }

    if (parts[1] === 'core') {
      try {
        if (req.method === 'GET' && parts[2] === 'status') return sendJson(res, 200, await configBuilder.coreStatus())
        if (req.method === 'POST' && parts[2] === 'check') return sendJson(res, 200, await configBuilder.checkConfig(db))
        if (req.method === 'POST' && parts[2] === 'reload') return sendJson(res, 200, await configBuilder.reloadCore(db))
        return sendJson(res, 405, { error: '方法不允许' })
      } catch (error) {
        return sendJson(res, 500, { error: error.message })
      }
    }

    const collection = parts[1]
    const recordId = parts[2]

    if (!COLLECTIONS.includes(collection)) return sendJson(res, 400, { error: '未知资源类型' })

  try {
    if (req.method === 'GET' && !recordId) {
      return sendJson(res, 200, db)
    }

    if (req.method === 'POST' && !recordId) {
      const body = sanitizeRecord(await readBody(req))
      const error = validate(collection, body)
      if (error) return sendJson(res, 400, { error })
      const record = { id: crypto.randomUUID(), ...body }
      db[collection].push(record)
      persist()
      return sendJson(res, 201, record)
    }

    if ((req.method === 'PUT' || req.method === 'DELETE') && recordId) {
      const index = db[collection].findIndex((row) => row.id === recordId)
      if (index === -1) return sendJson(res, 404, { error: '记录不存在' })

      if (req.method === 'DELETE') {
        const [removed] = db[collection].splice(index, 1)
        persist()
        return sendJson(res, 200, removed)
      }

      const body = sanitizeRecord(await readBody(req))
      const error = validate(collection, body)
      if (error) return sendJson(res, 400, { error })
      db[collection][index] = { id: recordId, ...body }
      persist()
      return sendJson(res, 200, db[collection][index])
    }

    return sendJson(res, 405, { error: '方法不允许' })
  } catch (error) {
    const status = error.status || 500
    return sendJson(res, status, { error: error.message })
  }
  }

  if (req.method === 'GET' && parts[0] === 'sub') {
    const subToken = process.env.SUB_TOKEN || ''
    if (subToken && url.searchParams.get('token') !== subToken) {
      return sendJson(res, 403, { error: '订阅令牌无效' })
    }
    const subscription = configBuilder.buildSubscription(db)
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Profile-Title': 'S-UI Simple',
      'Profile-Update-Interval': '86400',
      'Subscription-Userinfo': `upload=0; download=0; total=0; expire=0`
    })
    return res.end(subscription.body)
  }

  let filePath
  try {
    filePath = publicPath(url.pathname === '/' ? '/index.html' : url.pathname)
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not Found')
  }

  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
  fs.createReadStream(filePath).pipe(res)
})

server.listen(PORT, HOST, () => {
  console.log(`S-UI simple panel running at http://${HOST}:${PORT}`)
})
